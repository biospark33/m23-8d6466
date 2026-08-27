/**
 * CLI tests (Story DF3.1): scripts/fleet.ts run() contract + the MANDATORY
 * e2e demo (DoD): dispatch → status → teardown against the fake driver,
 * capturing the three outputs for the Dev Agent Record.
 *
 * Also covers (DoD): --help renders from the registry (no second list),
 * bidirectional verb coverage, malformed briefs via stdin → exit 2 with
 * zero provisioning, unknown runId → exit 4 mutating nothing, the 64 KiB cap
 * on BOTH sides of its boundary, the FleetError→exit-code table (2/3/4/5, plus
 * 6 for a teardown that succeeded and could not release its lock), the
 * registry-backed flag grammar, the run-id grammar as a path-traversal guard,
 * and the shared per-run lock BOTH harvest and teardown take
 * (scripts/lib/run-lock.ts — the same one sandbox-teardown holds).
 *
 * run() is called through `runCli` so its two sinks stay apart: `err` defaults
 * to `out`, and a merged capture cannot tell an ack on stdout from a refusal
 * envelope printed onto it.
 *
 * POSIX precondition: the lock choreography leans on hard links (`linkSync` as
 * the atomic claim, with one case forcing its failure via `--preload`), mode
 * bits (0o600/0o700 records dirs) and SIGKILL-able children. On a filesystem or
 * host without those — FUSE, some SMB mounts, Windows — the failures are
 * environmental, not regressions; run the suite on a supported host before
 * reading anything into a red here.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runMarkerPath } from "../../src/phase-engine/journal.ts";
import { deadPid } from "./helpers.ts";

import { Database } from "bun:sqlite";

import { makeLoserLedgerHook, MAX_STEPS_BYTES, observingMint, run } from "../../scripts/fleet.ts";
import { acquireRunLock, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { run as sandboxTeardownRun } from "../../scripts/sandbox-teardown.ts";
import { listVerbs, renderHelp } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { leakScan, MIN_REDACTABLE_LEN } from "../providers/fixtures/leak-scan.ts";
import { RUN_ID_RE, RunRecordStore } from "../../src/providers/run-record.ts";
import { FanoutRecordStore, mintFanoutId } from "../../src/fleet/fanout.ts";
import { DEFAULT_QUOTA_LIMITS } from "../../src/providers/quota.ts";
import type { FleetDeps, } from "../../scripts/fleet.ts";
import type { KeyApi } from "../../src/providers/credentials.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";
import { goodLedger, overBudgetLedger, type RecordingLedger } from "./helpers.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-1-cli-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// r7-T-b3: per-test scratch dirs (fleet-test-*) are swept after each test so
// a failure mid-test cannot accumulate litter across the suite.
const freshScratchDirs: string[] = [];
afterEach(() => {
  for (const d of freshScratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Losers of `within`'s race. `run()` is in-process and cannot be killed —
 * losing the race leaves it executing — and a straggler still mutating a
 * records dir or holding a lock-map entry is exactly the cross-test poisoning
 * that surfaces as a flake in a LATER case. Each loser is kept observable here
 * (its eventual rejection names itself instead of killing the runner as an
 * unhandled rejection) and joined, bounded, before the next test starts.
 */
const abandonedRuns: Promise<unknown>[] = [];

afterEach(async () => {
  if (abandonedRuns.length === 0) return;
  const losers = abandonedRuns.splice(0);
  // Bounded join: a straggler whose hang is PERMANENT (the unbounded retry loop
  // one case exists to catch) gets one window to drain — not a stall on every
  // remaining test — and then the failure names the poisoner instead of leaving
  // later cases to fail mysteriously.
  const drained = await Promise.race([
    Promise.allSettled(losers).then(() => true),
    Bun.sleep(5_000).then(() => false),
  ]);
  expect({ drained, losers: losers.length }).toEqual({ drained: true, losers: losers.length });
});

/**
 * The host token `run-lock.ts` writes into a lock body, READ OFF A REAL LOCK
 * rather than reimplemented here.
 *
 * `lockHost()` is module-private and platform-dependent (`<hostname>` on macOS,
 * `<hostname>/<pid-ns inode>` on Linux), and every stale/live fixture in this
 * file depends on matching it EXACTLY: `refuse` classifies a body whose host it
 * cannot match as foreign, and a foreign lock is deliberately never probed and
 * never marked stale. A hand-written token that drifts from the source's turns
 * every liveness assertion below into a vacuous foreign-host assertion that
 * passes whatever `isAlive` does.
 */
const LOCK_HOST = ((): string => {
  const probeDir = mkdtempSync(join(tmpRoot, "host-probe-"));
  const lock = acquireRunLock(probeDir, "qds-19700101-000000");
  const fields = readFileSync(lock, "utf8").trim().split(/\s+/);
  // Trust the read-back only if it really is the `<pid> <host> <ISO> <nonce>`
  // layout every fixture below assumes. A shape change left this indexing [1]
  // silently: whatever token landed there becomes every fixture's host token,
  // which `refuse` cannot match and therefore treats as foreign — and a
  // foreign lock is never probed and never marked stale, so the stale/live
  // assertions below all pass vacuously through the foreign-host arm their
  // comments warn about.
  expect(fields).toHaveLength(4);
  const host = fields[1] as string;
  // Host-shaped: never empty, and never an ISO timestamp — a timestamp in
  // field 2 is exactly how `parseLockBody` discriminates the pre-host layout,
  // so a host that looked like one would read as "no host field" everywhere.
  expect(host).not.toBe("");
  expect(/^\d{4}-/.test(host)).toBeFalse();
  releaseRunLock(lock);
  rmSync(probeDir, { recursive: true, force: true });
  return host;
})();

/**
 * A lock body in the CURRENT 4-field layout, `<pid> <host> <ISO> <nonce>`.
 *
 * Every fixture in this file used to write the pre-host 3-field layout, which
 * `refuse` parses to `host === undefined` and treats as foreign — so the stale
 * branch, the live branch and the whole `isAlive` probe were unreachable from
 * here and only the "liveness unknown from here" arm was ever exercised.
 */
function lockBody(pid: number, ageMs: number, nonce: string, host: string = LOCK_HOST): string {
  return `${pid} ${host} ${new Date(Date.now() - ageMs).toISOString()} ${nonce}\n`;
}

/**
 * A child process that takes the REAL run lock through `acquireRunLock` and
 * holds it, so a "held lock" in this file can be an actual concurrent holder
 * rather than a file the test wrote for itself. Modes:
 *
 *  - `probe`: acquire, say whether it won, release, exit.
 *  - `hold` / `destructive`: acquire, print nothing, block forever. The parent
 *    waits for the lock file, then signals. `destructive` marks the lock past
 *    the point of no return first, which is what makes the two signal
 *    outcomes (released vs deliberately kept) distinguishable.
 *  - `race`: spin to a shared wall-clock instant, then acquire/release in a
 *    loop, checking MUTUAL EXCLUSION from inside the critical section. Counting
 *    winners of a single simultaneous round does not work — process start
 *    jitter serializes them, and a check-then-act `claim` then wins that test
 *    too (measured). Two holders overlapping is the property, so the critical
 *    section is what has to notice.
 */
function lockChild(dir: string): string {
  const path = join(dir, "lock-child.ts");
  writeFileSync(
    path,
    `import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireRunLock, markRunLockDestructive, releaseRunLock } from ${JSON.stringify(join(import.meta.dir, "../../scripts/lib/run-lock.ts"))};
const [runsDir, runId, mode, startAt] = process.argv.slice(2) as string[];

if (mode === "race") {
  const me = String(process.pid);
  const marker = join(runsDir as string, "inside-the-critical-section");
  let acquired = 0;
  let violations = 0;
  const t = Number(startAt);
  while (Date.now() < t) { /* spin to the barrier */ }
  // Bounded by ROUNDS WON, not by attempts: a loser returns instantly, so an
  // attempt budget is spent entirely by whoever is not holding the lock and
  // that process never enters the critical section at all.
  const deadline = Date.now() + 8_000;
  while (acquired < 15 && Date.now() < deadline) {
    let lock: string;
    try {
      lock = acquireRunLock(runsDir as string, runId as string, "fleet invocation");
    } catch {
      await Bun.sleep(1); // losing is the correct outcome under contention
      continue;
    }
    acquired++;
    // Only ONE process may ever be here at a time. Both halves matter: an
    // occupied marker on entry means someone else is already inside, and a
    // marker that changed under us means someone else came in while we held it.
    if (existsSync(marker)) violations++;
    writeFileSync(marker, me);
    await Bun.sleep(1);
    try {
      if (readFileSync(marker, "utf8") !== me) violations++;
    } catch (e) {
      // When exclusion DOES break, a rival can remove the marker between our
      // write and our read; dying on that ENOENT leaves the parent no
      // "acquired N violations M" line to parse and fails the race opaquely.
      // The vanished marker IS the overlap — counted as one.
      if ((e as { code?: string }).code === "ENOENT") violations++;
      else throw e;
    }
    rmSync(marker, { force: true });
    try {
      releaseRunLock(lock);
    } catch {
      violations++; // "it holds someone else's claim" is the same overlap
    }
  }
  process.stdout.write(\`acquired \${acquired} violations \${violations}\\n\`);
  process.exit(0);
}

try {
  const lock = acquireRunLock(runsDir as string, runId as string, "fleet invocation");
  if (mode === "destructive") markRunLockDestructive(lock);
  process.stdout.write("won\\n");
  // \`probe\` reports and LEAVES. \`hold\`/\`destructive\` block, so the parent
  // decides when the lock comes off — but a probe that blocked on success made
  // the "a second acquirer is refused" assertion time out instead of failing,
  // which is the slowest and least legible way to report a stolen lock.
  if (mode === "probe") { releaseRunLock(lock); process.exit(0); }
  await new Promise(() => {});
} catch (e) {
  process.stdout.write(\`lost \${(e as { code?: string }).code}\\n\`);
  process.exit(9);
}
`,
  );
  return path;
}

/**
 * A `--preload` that makes `link(2)` fail with `$LINK_FAILS_AS`, so `claim`'s
 * no-hard-link fallback can be driven at all.
 *
 * `writeLockDirect` is the LIVE acquire path on FUSE and overlay mounts, exFAT
 * and SMB shares and several macOS Docker bind-mount configs — every one of
 * which answers EPERM/ENOSYS/EOPNOTSUPP from `linkSync` on every call — and no
 * filesystem primitive a test can reach produces those errnos on demand.
 * Patching in a CHILD process rather than with `mock.module`: mocking `node:fs`
 * in THIS file makes Bun re-evaluate the whole `scripts/fleet.ts` module graph
 * and hang before the first test runs. The child's fs is its own.
 */
function linkPreload(dir: string): string {
  const path = join(dir, "link-preload.ts");
  writeFileSync(
    path,
    `import { createRequire } from "node:module";
const fs = createRequire(import.meta.url)("node:fs");
const real = fs.linkSync;
fs.linkSync = (a: string, b: string): void => {
  const code = process.env.LINK_FAILS_AS;
  if (code === undefined || code === "") return real(a, b);
  const e = new Error(\`link \${code}\`) as NodeJS.ErrnoException;
  e.code = code;
  throw e;
};
`,
  );
  return path;
}

/** Resolve, or fail with attribution rather than dying on the runner's timeout. */
async function within<T>(what: string, ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lost = false;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          lost = true;
          reject(new Error(`${what} did not finish within ${ms}ms`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Either arm: the loser keeps running after this function returns, so its
    // eventual rejection must be observed here — and it is remembered so the
    // file-level afterEach above can join it before the next test starts.
    void p.catch(() => {});
    if (lost) abandonedRuns.push(p);
  }
}

/** Read a stream, stopping at `cap` bytes: an unbounded read of a runaway producer is a hang. */
async function readCapped(stream: ReadableStream<Uint8Array> | null, cap = 64 * 1024): Promise<string> {
  if (stream === null) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < cap) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a stream just until `marker` appears, then RELEASE it so a later
 * `readCapped` can drain the rest. For a child whose readiness is one early
 * line on a stream the assertions afterwards want whole — readCapped cannot do
 * this, because it waits for the stream to END and the child is still running.
 */
async function readUntilMarker(stream: ReadableStream<Uint8Array> | null, marker: string, ms = 30_000): Promise<string> {
  if (stream === null) throw new Error(`stream already closed before "${marker}" could appear`);
  const reader = stream.getReader();
  const deadline = Date.now() + ms;
  let acc = "";
  try {
    for (;;) {
      if (acc.includes(marker)) return acc;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`"${marker}" never appeared within ${ms}ms (got ${JSON.stringify(acc)})`);
      const pending = reader.read();
      // Losing the timeout race leaves the read pending, and releaseLock below
      // rejects it — observed nowhere, it would surface as an unhandled
      // rejection and kill the runner instead of naming the missing marker.
      pending.catch(() => {});
      let timedOut = false;
      const tick = Bun.sleep(remaining).then(() => {
        timedOut = true;
        return null;
      });
      const result = await Promise.race([pending, tick]);
      if (timedOut) continue; // loop head re-checks the deadline and names the marker
      if (result === null || result.done) throw new Error(`stream ended before "${marker}" (got ${JSON.stringify(acc)})`);
      acc += Buffer.from(result.value).toString("utf8");
    }
  } finally {
    reader.releaseLock();
  }
}

/** Wait for `path` to appear, bounded. */
async function awaitPath(path: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`${path} never appeared within ${ms}ms`);
    await Bun.sleep(10);
  }
}

/**
 * Brief ingress cap, as a LITERAL rather than an import of the CLI's own
 * constant: importing it would make an implementation that quietly lowers the
 * cap to 8 KiB pass both sides of this boundary. The cap is 64 KiB of BYTES,
 * and `briefTooLarge` below re-asserts that the CLI names this same number.
 */
const MAX_BRIEF_BYTES = 64 * 1024;

/**
 * The verb set, pinned. Deriving it from `listVerbs()` makes every assertion
 * below shrink with the registry: delete `harvest` and a registry-derived loop
 * still passes.
 */
const EXPECTED_VERBS = ["dispatch", "status", "harvest", "teardown", "fanout", "rank"] as const;

/** Exit code for `fleet <verb>` with no positional and an injected driver. */
const BARE_VERB_EXIT: Record<(typeof EXPECTED_VERBS)[number], number> = {
  dispatch: 2, // brief read, then refused as invalid JSON — never unknown-verb
  status: 0, // no runs is a state, not an error (AC4)
  harvest: 2, // missing <run-id>
  teardown: 2, // missing <run-id>
  fanout: 2, // no --n given (DF3.2; the brief would be refused next anyway)
  rank: 2, // missing <fanout-id>
};

/**
 * The manifest path every brief here carries, RELATIVE to the containment root
 * (`deps().repoRoot`, the case's tmpdir). The schema now refuses an absolute
 * `manifestPath` outright — `resolve(repoRoot, "/etc/shadow")` discards the
 * root, so absoluteness was the containment hole — and dispatch resolves the
 * relative form against `repoRoot`, which is what makes it land on the file
 * `validBriefJson` just wrote.
 */
const MANIFEST_REL = join("manifests", "pipeline.json");

function validBriefJson(dir: string): string {
  const manifestDir = join(dir, "manifests");
  mkdirSync(manifestDir, { recursive: true });
  const manifestPath = join(manifestDir, "pipeline.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: "1.0.0",
      pipelineId: "e2e-pipeline",
      runBudgetMs: 200_000,
      phases: [
        { name: "plan", kind: "engineer", description: "Draft the approach for the change", maxDurationMs: 10_000, retries: 0 },
        { name: "build", kind: "code", description: "Run the repository test suite", command: ["bun", "test"], maxDurationMs: 40_000, retries: 0 },
      ],
    }),
  );
  return JSON.stringify({
    repoSlug: "owner/repo",
    issueId: 42,
    commitSha: "b".repeat(40),
    manifestPath: MANIFEST_REL,
    repoUrl: "https://github.com/owner/repo",
  });
}

/**
 * The env the CLI's OWN defaults read when a test injects neither `--dir` nor
 * `deps.store`. Left alone, `$QDS_RUNS_DIR` and friends made this suite resolve
 * differently on a developer's shell than in CI, and pointed the "nothing was
 * provisioned" assertions at `<repo>/.sandbox/...` — a path no assertion here
 * checks. Every key is snapshotted and restored; the two directory ones are
 * REDIRECTED into the case's tmpdir rather than deleted, which is what makes
 * `expect(existsSync(<tmp>/.sandbox/runs)).toBeFalse()` a claim about the path
 * the CLI would actually build.
 */
const CLI_ENV_KEYS = [
  "QDS_RUNS_DIR",
  "QDS_FAKE_BOXES_DIR",
  "QDS_COST_LEDGER_FILE",
  "QDS_COST_CONFIG_FILE",
  // Not redirected, only snapshotted: the cases that care unset it (a host
  // that exports one would otherwise hide the refusal they assert on).
  "OPENROUTER_PROVISIONING_KEY",
] as const;

/**
 * A keyApi that refuses to be touched at all — D8's credential-free claim for
 * `harvest` as a tripwire rather than a comment. Harvest builds no key API, so
 * ANY property read of an injected one is already the regression; the throw
 * names which one was read.
 */
function keyApiTripwire(): KeyApi {
  return new Proxy({} as KeyApi, {
    get: (_target, prop) => {
      throw new Error(`harvest touched keyApi.${String(prop)} — harvest is credential-free (D8)`);
    },
  });
}

/**
 * A FakeDriver whose `exec` is shadowed for ONE argv, leaving every other
 * primitive real. Prototype delegation, not a stub: the box, the key delivery
 * and the fill all still happen, so the failure under test is the only one.
 */
function driverWith(base: FakeDriver, over: Partial<FakeDriver>): FakeDriver {
  return Object.assign(Object.create(base) as FakeDriver, over);
}

describe("scripts/fleet.ts (DF3.1 CLI)", () => {
  let dir: string;
  let boxesDir: string;
  let runsDir: string;
  /** Both streams, interleaved — what a terminal shows. */
  let captured: string[];
  /** stdout only, and stderr only: `run()`'s two sinks, kept apart. */
  let outOnly: string[];
  let errCaptured: string[];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cli-"));
    boxesDir = join(dir, "boxes");
    runsDir = join(dir, "runs");
    captured = [];
    outOnly = [];
    errCaptured = [];
    savedEnv = Object.fromEntries(CLI_ENV_KEYS.map((k) => [k, process.env[k]]));
    // An explicit ledger/config file would follow the CLI's env tier and defeat
    // the --dir scoping case; the two directories are redirected, not deleted,
    // so the CLI's cwd-relative defaults land inside the case's tmpdir.
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_COST_LEDGER_FILE;
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.QDS_COST_CONFIG_FILE;
    process.env.QDS_RUNS_DIR = join(dir, ".sandbox", "runs");
    process.env.QDS_FAKE_BOXES_DIR = join(dir, ".sandbox", "fake-boxes");
    mkdirSync(join(dir, ".sandbox"), { recursive: true });
    // Two locations because there are two resolution paths, and the teardown
    // e2e below proves which one is live: `--dir <dir>/runs` resolves the cost
    // config one level up from the store (`<dir>/cost-config.json`), while a
    // cwd-relative default would find `.sandbox/cost-config.json`. Writing both
    // keeps the fixture honest either way; the `--dir` scoping test asserts the
    // ledger lands beside the runs dir and nowhere else.
    writeFileSync(join(dir, ".sandbox", "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    writeFileSync(join(dir, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function deps(briefJson: string): Partial<FleetDeps> {
    return {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      store: new RunRecordStore(runsDir),
      ledgerFactory: () => goodLedger(),
      readBrief: async () => briefJson,
      // INV-1's containment root, injected rather than inherited from the
      // process cwd. Before this seam existed every case with a tmpdir manifest
      // had to chdir, mutating a global shared with every other test file.
      repoRoot: dir,
    };
  }

  const out = (s: string): void => {
    outOnly.push(s);
    captured.push(s);
  };

  /**
   * run()'s 4th sink. It exists because `err` DEFAULTS to `out`: every call
   * that passed three arguments merged the two streams, so every assertion on a
   * refusal envelope held just as well if `printError` wrote it to stdout —
   * while `import.meta.main` binds `err` to fd 2 precisely so `fleet status |
   * jq` never has to parse one. Diagnostics are pushed to BOTH arrays so
   * `text()` still reads as a terminal does (interleaved, in order); the split
   * is what `errCaptured` and `outOnly` are asserted on.
   */
  const errOut = (s: string): void => {
    errCaptured.push(s);
    captured.push(s);
  };

  /** Every invocation in this file, with the two sinks kept apart. */
  const runCli = (argv: readonly string[], d?: Partial<FleetDeps>): Promise<number> => run(argv, out, d, errOut);

  const reset = (): void => {
    captured.length = 0;
    outOnly.length = 0;
    errCaptured.length = 0;
  };

  const text = (): string => captured.join("");

  /**
   * Nothing was provisioned.
   *
   * `FakeDriver` creates its box ROOT lazily, in `create()`, rather than in its
   * constructor — AC1's "validation completes before the first side effect"
   * (story df3-1 :58-62): building a driver for an invocation that is about to
   * be refused must not put a directory on disk. So the strongest form of this
   * claim is that `boxesDir` does not exist AT ALL, and an empty one is the
   * weakest that still holds (some earlier box in the same case made the root).
   * Both are "no box was created"; a `readdirSync` of the absent one is an
   * ENOENT that says nothing about provisioning.
   */
  const expectNoBoxes = (): void => {
    expect(existsSync(boxesDir) ? readdirSync(boxesDir) : []).toHaveLength(0);
  };

  // ─── --help renders from the registry (AC6) ────────────────────────────────

  test("--help renders the registry's four verbs and their declared flags", async () => {
    const code = await runCli(["--help"], deps(""));
    expect(code).toBe(0);
    const helpText = text();
    // The registry is the contract; pinning it to a literal is what makes the
    // assertions below fail when a verb is dropped instead of shrinking with it.
    expect(listVerbs().map((v) => v.verb)).toEqual([...EXPECTED_VERBS]);
    expect(helpText.startsWith("Usage: fleet <verb> [options]")).toBeTrue();
    expect(helpText.endsWith("\n")).toBeTrue();
    // Verbs are pinned at a LINE boundary, not by substring: "harvest" is a
    // substring of "--no-harvest", so a registry that dropped the harvest VERB
    // while teardown kept its waiver flag satisfied `toContain` forever. Every
    // verb must open its own rendered line (`  <verb><pad> <summary>`).
    const helpLines = helpText.split("\n");
    for (const verb of EXPECTED_VERBS) {
      expect({ verb, opensLine: helpLines.some((l) => l.startsWith(`  ${verb} `)) }).toEqual({
        verb,
        opensLine: true,
      });
    }
    // Same discipline for the flags, token-or-EOL: a future flag that merely
    // CONTAINS another one must not satisfy that other flag's pin.
    for (const flag of ["--driver", "--brief", "--dir", "--port", "--no-harvest", "--help"]) {
      expect({ flag, token: new RegExp(`(^|\\s)${flag}(?=\\s|$)`).test(helpText) }).toEqual({ flag, token: true });
    }
    expect(helpText).toContain("Exit codes:");
    // No second list: the text IS the registry rendering, byte for byte.
    expect(helpText).toBe(`${renderHelp(listVerbs())}\n`);
  });

  /**
   * The exit codes rendered on ONE verb's `Exit codes:` line of the help text.
   * Scoped per verb: the table is per verb, and a whole-string search for "6"
   * finds it in another verb's line, in a byte count, or in a run id.
   */
  const helpExitCodesFor = (help: string, verb: string): number[] => {
    const lines = help.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`  ${verb} `));
    expect(start).toBeGreaterThanOrEqual(0);
    const line = lines.slice(start + 1).find((l) => l.includes("Exit codes:")) as string;
    expect(line).toBeDefined();
    return (line.split("Exit codes:")[1] as string).split(",").map((n) => Number(n.trim()));
  };

  test("the help text's per-verb exit-code table is bound to codes the CLI really returns", async () => {
    // `toBe(renderHelp(listVerbs()))` above compares the CLI's output to the
    // registry rendering, so ANY registry value renders "correctly" — including
    // a table missing a code the verb demonstrably returns. That is not a
    // hypothetical: `dispatch` declared [0,1,2,3,5] while `scripts/fleet.ts`
    // returned 6 for an unwritable ack, and nothing here paired the two. Both
    // sides of this file's help coverage were about RENDERING; this one is about
    // the table being TRUE.
    //
    // A code observed per verb, then required to appear on that verb's own line
    // of the text an operator reads — the printed table, not the array behind
    // it, because the printed table is the artifact DF3.5 generates a skill's
    // exit handling from.
    const observed: [string, number][] = [];
    const record = async (verb: string, argv: string[], d?: Partial<FleetDeps>): Promise<void> => {
      reset();
      observed.push([verb, await runCli(argv, d ?? deps(validBriefJson(dir)))]);
    };

    // dispatch: 0 (a real provisioning run) and 2 (a brief that will not parse).
    await record("dispatch", ["dispatch", "--driver", "fake"]);
    await record("dispatch", ["dispatch", "--driver", "fake"], deps("{not json"));
    // dispatch 6: the box is LIVE and the ack could not be written. The code
    // that was missing from the registry, reachable only this way.
    reset();
    const brokenStdout = (): never => {
      // Coded like every sibling fixture: the errno is what `emit` branches on,
      // and the dispatch ack deliberately does NOT go through `emit` — its
      // runId is the only handle on a live box. With `.code` set, rerouting the
      // ack onto the tolerant path flips this probe to a silent exit 0 instead
      // of re-reporting 6 through whatever envelope the refactor invented.
      const e = new Error("EPIPE: broken pipe, write") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    observed.push(["dispatch", await run(["dispatch", "--driver", "fake"], brokenStdout, deps(validBriefJson(dir)), errOut)]);

    // status: 0 over the runs the dispatches above left, 4 for an id with no
    // record and no box, 2 for a malformed one.
    await record("status", ["status", "--driver", "fake"]);
    await record("status", ["status", "--driver", "fake", "qds-19990101-000000"]);
    await record("status", ["status", "--driver", "fake", "NOT_AN_ID"]);
    // harvest / teardown: 2 (no id), 4 (an id with no record).
    for (const verb of ["harvest", "teardown"]) {
      await record(verb, [verb, "--driver", "fake"]);
      await record(verb, [verb, "--driver", "fake", "--dir", runsDir, "qds-19990101-000000"]);
    }

    // The text the CLI PRINTS, read back off it — not `renderHelp(listVerbs())`,
    // which is the tautology this test exists to escape.
    reset();
    expect(await runCli(["--help"], deps(""))).toBe(0);
    const help = outOnly.join("");
    const undeclared = observed.filter(([verb, code]) => !helpExitCodesFor(help, verb).includes(code));
    expect(undeclared.map(([verb, code]) => `fleet ${verb} → exit ${code} is not on its help table`)).toEqual([]);
    // …and the other direction, against the REGISTRY rather than the probes:
    // every code a verb DECLARES must sit on that verb's own line of the
    // printed text, read back through an independent parser. The byte-equality
    // pin above cannot see this — both sides of it come from `renderHelp`, so a
    // renderer that filtered or hard-coded a subset still matched itself — and
    // observed-set coverage alone never would: dispatch's 3 (setup gate) and 5
    // (refused before provisioning) are deliberately not probed here because
    // their full cases live in the gate/budget sections below, so they were
    // declared and printed without anything pairing print to declaration.
    for (const entry of listVerbs()) {
      expect({
        verb: entry.verb,
        table: helpExitCodesFor(help, entry.verb),
      }).toEqual({ verb: entry.verb, table: [...entry.exitCodes] });
    }
    // …and the probes really did exercise more than "everything exits 2": a
    // vacuous set would satisfy the check above for any table at all.
    expect(new Set(observed.map(([, code]) => code))).toEqual(new Set([0, 2, 4, 6]));
  });

  test("every documented help path exits 0 and prints the SAME usage, byte for byte", async () => {
    // `toContain("Usage: …")` was satisfied by any output carrying the global
    // banner, so `fleet dispatch --help` rendering `status`'s flag section —
    // or a per-verb section that silently dropped half its flags — passed. The
    // registry's own note is explicit that there IS no verb-specific help: all
    // six shapes answer with one string. Pin the string.
    const expected = `${renderHelp(listVerbs())}\n`;
    for (const argv of [["--help"], ["-h"], ["help"], ["dispatch", "--help"], ["status", "-h"], ["teardown", "--help"]]) {
      reset();
      const code = await runCli(argv, deps(""));
      expect({ argv, code }).toEqual({ argv, code: 0 });
      // Help is OUTPUT, not a diagnostic: `fleet --help | less` must not need
      // fd 2, and a refusal must not be able to masquerade as one.
      expect({ argv, help: outOnly.join("") }).toEqual({ argv, help: expected });
      expect(errCaptured).toHaveLength(0);
    }
  });

  test("with no repoRoot injected the containment root defaults to the process cwd", async () => {
    // Every other case injects `repoRoot`, so without this one a default that
    // regressed to "the brief's own directory" would keep the whole file green
    // while shipping the traversal INV-1 exists to stop. The manifest this
    // brief names exists ONLY under the case's tmpdir, so resolved against the
    // repo the CLI is actually run from it must not be found — and the refusal
    // names that root, which is what pins WHICH root the default is.
    const { repoRoot: _omitted, ...noRoot } = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver", "fake"], noRoot);
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as {
      code: string;
      remediation: string;
      manifestPath?: string;
    };
    expect(envelope.code).toBe("manifest-rejected");
    // In the SENTENCE that names the containment root, not merely somewhere in
    // the output. `toContain(process.cwd())` was satisfied by any message that
    // happened to embed the repo root — an absolute import path in a stack, a
    // resolved default elsewhere in the envelope — so a remediation that named
    // the wrong root, or none, still passed the one assertion that exists to pin
    // WHICH root the default is.
    expect(envelope.remediation).toContain(`point manifestPath at one beneath ${process.cwd()}`);
    // …and the path it refused is the brief's relative `manifestPath` RESOLVED
    // against that same root — which is the default under test, spelled out as a
    // path rather than as a sentence. Resolved against the brief's own directory
    // (the regression this case exists for) it would be the tmpdir's.
    expect(envelope.manifestPath).toBe(join(process.cwd(), MANIFEST_REL));
    expect(text()).not.toContain(dir);
    expect(readdirSync(runsDir)).toHaveLength(0);
    expectNoBoxes();
  });

  test("no verb → exit 2 usage (a bare `fleet` is a mistyped invocation, not a help request)", async () => {
    const code = await runCli([], deps(""));
    expect(code).toBe(2);
    const refusal = text();
    expect(refusal).toContain("no verb given");
    // The remediation is the usage text — an operator who typed nothing needs
    // the verb list, not just the refusal.
    for (const verb of EXPECTED_VERBS) expect(refusal).toContain(verb);
  });

  // ─── bidirectional verb coverage (AC6) ─────────────────────────────────────

  test("every registry verb is dispatchable, with the exact exit its bare form owes", async () => {
    expect(listVerbs().map((v) => v.verb)).toEqual([...EXPECTED_VERBS]);
    for (const verb of EXPECTED_VERBS) {
      reset();
      const code = await runCli([verb], deps(""));
      expect(text()).not.toContain("unknown-verb");
      // `expect([0,2]).toContain(code)` was satisfied by a verb that had
      // stopped working — each verb owes ONE code here.
      expect({ verb, code }).toEqual({ verb, code: BARE_VERB_EXIT[verb] });
    }
  });

  test("a non-registry verb is refused with unknown-verb (exit 2) and provisions nothing", async () => {
    // Words a drifting dispatch switch would plausibly grow — each must be
    // refused by the registry check BEFORE any verb body runs.
    for (const word of ["warp", "reap", "list", "destroy", "provision", "Dispatch", "dispatch-all"]) {
      reset();
      const d = deps("");
      const code = await runCli([word], d);
      expect({ word, code }).toEqual({ word, code: 2 });
      // Off the diagnostics sink — a refusal envelope never rides stdout.
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string };
      expect(envelope.code).toBe("unknown-verb");
      expect(envelope.message).toBe(`unknown verb ${JSON.stringify(word)}`);
      expect(readdirSync(runsDir)).toHaveLength(0);
      expectNoBoxes();
    }
  });

  test("every dispatched arm has a registry entry, fall-through arms included", async () => {
    // The other direction of AC6 parity, and the only way to see it: the
    // registry check runs BEFORE the switch, so an unregistered arm is
    // unreachable at runtime and no black-box probe can find it. Read the arms.
    //
    // The scan used to be `verb === "([a-z-]+)"` alone, which promised a
    // guarantee the regex could not give: `teardown` is dispatched as the `else`
    // fall-through and never appeared in the match set at all, so the assertion
    // ran over 3 of the 4 shipped arms — and a new verb written as a second
    // fall-through or as a `switch`/`case` was invisible to it. Both explicit
    // forms are matched now, the fall-through set is NAMED rather than assumed,
    // and the arm COUNT is pinned, so an arm this scan cannot see fails loudly
    // here instead of going unread.
    const source = readFileSync(join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    const armed = [...source.matchAll(/verb === "([a-z-]+)"|case "([a-z-]+)"/g)].map((m) => (m[1] ?? m[2]) as string);
    expect(armed.length).toBeGreaterThan(0);
    const registry = listVerbs().map((v) => v.verb);
    for (const verb of armed) expect(registry).toContain(verb);

    // Everything the registry declares that the scan did NOT see is dispatched
    // by fall-through. Naming the set is what makes a SECOND one fail.
    const fallThrough = registry.filter((v) => !armed.includes(v));
    expect(fallThrough).toEqual(["teardown"]);
    // …and "dispatched by fall-through" is only true if it reaches a verb body:
    // each must answer with its own grammar, never the unknown-verb refusal.
    for (const verb of fallThrough) {
      reset();
      expect({ verb, code: await runCli([verb, "--driver", "fake"], deps("")) }).toEqual({ verb, code: 2 });
      expect(text()).toContain(`${verb} requires <run-id>`);
      expect(text()).not.toContain("unknown-verb");
    }
    // Every arm accounted for exactly once: explicit + fall-through = registry.
    expect(new Set(armed).size + fallThrough.length).toBe(registry.length);
  });

  test("the registry owns the per-verb flag grammar: `status --brief x` is refused, not ignored", async () => {
    const code = await runCli(["status", "--driver", "fake", "--brief", "x"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("status does not take --brief");
    // The remediation lists what status DOES take.
    expect(text()).toContain("--driver");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--no-harvest is a teardown flag only", async () => {
    const code = await runCli(["dispatch", "--driver", "fake", "--no-harvest"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("dispatch does not take --no-harvest");
  });

  test("the per-verb flag table is enforced for EVERY wrong pair, not two spot checks", async () => {
    // `status --brief x` and `dispatch --no-harvest` above are two of the eight
    // wrong pairs the registry forbids, and the refusal is built from `entry
    // .flags` per verb — so a verb whose `allowed` set was computed from the
    // WRONG entry (an off-by-one in the lookup, a shared Set) is refused on the
    // two pairs that are checked and accepted on the six that are not. `harvest
    // --port` then silently exposes nothing, and `teardown --brief` reads a
    // brief the verb has no use for.
    for (const [verb, flag] of [
      ["dispatch", "--no-harvest"],
      ["status", "--brief"],
      ["status", "--port"],
      ["status", "--no-harvest"],
      ["harvest", "--brief"],
      ["harvest", "--port"],
      ["harvest", "--no-harvest"],
      ["teardown", "--brief"],
      ["teardown", "--port"],
    ] as const) {
      // The registry really does withhold it — otherwise this loop asserts a
      // refusal for a flag the verb is entitled to.
      expect(listVerbs().find((v) => v.verb === verb)?.flags.map((f) => f.name)).not.toContain(flag);
      reset();
      // Boolean flags take no value; the other two consume the token after them.
      const argv =
        flag === "--no-harvest"
          ? [verb, "--driver", "fake", flag]
          : [verb, "--driver", "fake", flag, flag === "--port" ? "8080" : "x"];
      expect({ verb, flag, code: await runCli(argv, deps("")) }).toEqual({ verb, flag, code: 2 });
      expect(text()).toContain(`${verb} does not take ${flag}`);
      // The remediation lists what the verb DOES take, so the operator is not
      // sent back to `--help` for it.
      expect(text()).toContain(`flags for ${verb}:`);
      expect(outOnly).toHaveLength(0);
    }
  });

  test("a boolean flag given a value is `takes no value`, not `unknown flag`", async () => {
    // `parseValueFlags` evaluates the `=` form first and matches it against the
    // VALUE flags only, so a DECLARED boolean written `--no-harvest=true` came
    // back as an unknown flag — sending the operator to look for a flag that
    // exists and that they spelled correctly. `scripts/fleet.ts` carries a
    // dedicated loop for exactly this, and nothing exercised it.
    for (const [argv, flag] of [
      [["teardown", "--driver", "fake", "--no-harvest=true", "qds-20260101-abcdef"], "--no-harvest"],
      [["status", "--driver", "fake", "--help=1"], "--help"],
    ] as const) {
      reset();
      expect({ argv, code: await runCli([...argv], deps("")) }).toEqual({ argv, code: 2 });
      expect(text()).toContain(`${flag} takes no value`);
      expect(text()).not.toContain("unknown flag");
      // …and it is a refusal, not a help request that happened to exit 2.
      expect(outOnly).toHaveLength(0);
    }
    // `-h=1` is deliberately NOT in that list: the `=` form is `--`-only
    // (cli-args.ts's `/^--([^=]+)=(.*)$/`), so a single-dash token that is not
    // exactly `-h` never reaches the boolean check and is refused one step
    // earlier by `rejectStraySingleDash`. Same exit, and a more accurate
    // message — pinned here so the difference is a decision rather than a gap.
    reset();
    expect(await runCli(["status", "--driver", "fake", "-h=1"], deps(""))).toBe(2);
    expect(text()).toContain("unknown flag: -h=1");
  });

  test("EVERY refusal is a diagnostic: stderr carries it and stdout stays empty", async () => {
    // The file's own two-sink premise (header), asserted once over the whole
    // refusal surface. ~20 cases below assert on the MERGED `text()`, which
    // holds just as well if `printError` wrote the envelope to stdout — and only
    // two of them pin `outOnly`. A regression routing ONE refusal to stdout
    // breaks `fleet status | jq` for that path and passes every one of them,
    // which is precisely why `run()` grew a fourth sink.
    //
    // One case per refusal SITE rather than per message: the tokenizer, the
    // per-verb table, the duplicate guards, the run-id grammar, the driver
    // registry, the brief reader, the schema, the store constructor and the
    // record probe each build their envelope through a different call.
    //
    // `injected: false` for the two whose refusal comes from a dependency the
    // default `deps()` would stand in for — an injected driver makes `--driver`
    // inert, so `status --driver no-such-driver` exits 0 with a fleet listing.
    const refusals: readonly { argv: string[]; injected?: false }[] = [
      { argv: [] }, // no verb
      { argv: ["warp"] }, // unknown verb
      { argv: ["status", "--verbose"] }, // unknown flag (tokenizer)
      { argv: ["status", "--driver", "fake", "--brief", "x"] }, // wrong verb for the flag
      { argv: ["status", "--driver", "fake", "--dir", runsDir, "--dir", runsDir, "x"] }, // duplicate value flag
      { argv: ["teardown", "--driver", "fake", "--no-harvest", "--no-harvest", "qds-20260101-abcdef"] }, // duplicate bool
      { argv: ["status", "--driver"] }, // value flag with no value
      { argv: ["dispatch", "--driver", "fake", "--port", "0"] }, // range check
      { argv: ["status", "--driver", "fake", "NOT_AN_ID"] }, // run-id grammar
      { argv: ["status", "--driver", "no-such-driver"], injected: false }, // driver registry
      { argv: ["dispatch", "--driver", "fake", "--brief", join(dir, "nope.json")], injected: false }, // brief reader
      { argv: ["dispatch", "--driver", "fake"] }, // schema (the injected brief is not JSON)
      { argv: ["dispatch", "--driver", "fake", "somefile.json"] }, // extra positional
      { argv: ["harvest", "--driver", "fake"] }, // missing <run-id>
      { argv: ["harvest", "--driver", "fake", "--dir", runsDir, "qds-19990101-000000"] }, // record probe → 4
      { argv: ["teardown", "--driver", "fake", "--dir", runsDir, "qds-19990101-000000"] },
      { argv: ["status", "--driver", "fake", "qds-19990101-000000"] },
      { argv: ["status", "--driver", "fake", "--dir", join(dir, "no-such-dir")], injected: false }, // --dir probe
    ];
    for (const { argv, injected } of refusals) {
      reset();
      const code = await runCli([...argv], injected === false ? {} : deps("{not json"));
      // A refusal, whatever its code — this is about the SINK, so pinning each
      // code here would only duplicate the cases that own them.
      expect({ argv, refused: code !== 0 }).toEqual({ argv, refused: true });
      expect({ argv, stdout: outOnly.join("") }).toEqual({ argv, stdout: "" });
      // …and it really did say something: an empty stderr would satisfy the
      // stdout claim above perfectly.
      expect({ argv, saidSomething: errCaptured.join("") !== "" }).toEqual({ argv, saidSomething: true });
      // Parseable JSON lines, every one: `2>&1 | jq` is how these are read, and
      // a bare sentence on the diagnostics sink breaks that as surely as an
      // envelope on stdout breaks the other one.
      for (const line of errCaptured.join("").trimEnd().split("\n")) {
        expect({ argv, line, code: (JSON.parse(line) as { code?: unknown }).code }).toMatchObject({
          code: expect.any(String),
        });
      }
    }
  });

  test("a flag no verb declares is refused by the tokenizer, not swallowed", async () => {
    // `status --brief x` above is a flag the REGISTRY knows on the wrong verb —
    // a different check. This one nothing declares, so it must die in
    // parseValueFlags before any verb body runs.
    const code = await runCli(["status", "--verbose"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("unknown flag: --verbose");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--flag=value is the same flag as --flag <value>, and its VALUE is consumed", async () => {
    // Fully supported, and therefore routed through the duplicate check below
    // and the per-verb allowed-flag check above; untested, `--driver=fake` could
    // regress to "unknown flag" and every operator who types it is stuck.
    //
    // Paired with a flag whose value actually changes the outcome. On its own
    // `status --driver=fake` proved only "not rejected as an unknown flag":
    // `--driver` is inert wherever `deps.driver` is injected and `status` on an
    // empty store prints nothing, so a splitter yielding `"=fake"` or `"fak"`
    // passed identically. `--port` is the one flag whose parsed value reaches
    // the ack, so a mis-split value cannot survive it.
    const shared = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver=fake", "--port=8080"], shared);
    expect(code).toBe(0);
    expect(text()).not.toContain("unknown flag");
    const ack = JSON.parse(outOnly.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.httpsUrl).toBe(`https://${ack.vmName}-8080.fake.local`);
    expect((shared.store as RunRecordStore).get(ack.runId).ports).toEqual([8080]);
  });

  test("a repeated flag is refused, never last-win", async () => {
    // Silent last-win here means `fleet teardown --dir /safe --dir /prod <id>`
    // destroys against /prod while the operator reads /safe off their own
    // command line.
    const code = await runCli(["teardown", "--driver", "fake", "--dir", join(dir, "a"), "--dir", join(dir, "b"), "qds-20260101-abcdef"], deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("--dir given more than once");
    expect(existsSync(join(dir, "a"))).toBeFalse();
    expect(existsSync(join(dir, "b"))).toBeFalse();
  });

  test("a value flag with a flag-looking or missing value is refused, never given the next token", async () => {
    // Without the `startsWith("--")` clause `--dir` swallows `--driver` and the
    // CLI acts on a runs directory literally named "--driver": a fresh empty
    // store, so teardown exits 4 while the real box keeps billing.
    //
    // The refusal names WHICH flag was left without a value. The bare substring
    // was identical for both cases here, so a parser that blamed the flag it
    // swallowed rather than the one that swallowed it — `--driver requires a
    // non-empty value` for the first argv, which sends the operator to fix the
    // flag they typed correctly — passed both.
    const cases: [string[], string][] = [
      [["teardown", "--dir", "--driver", "fake", "qds-20260101-abcdef"], "--dir requires a non-empty value"],
      [["status", "--driver"], "--driver requires a non-empty value"], // trailing, no value at all
    ];
    for (const [argv, message] of cases) {
      reset();
      const code = await runCli(argv, deps(""));
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(message);
      expect(existsSync(join(dir, "--driver"))).toBeFalse();
    }
  });

  test("an extra positional is refused on every verb that owes exactly one", async () => {
    // `fleet dispatch brief.json` silently ignoring the path blocks on stdin in
    // a TTY-less CI job; `fleet teardown id1 id2` tears down only id1 while the
    // operator believes both are gone.
    const cases: [string[], string][] = [
      [["dispatch", "--driver", "fake", "somefile.json"], "dispatch takes no positional arguments"],
      [["status", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "status takes at most one <run-id>"],
      [["teardown", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "teardown takes exactly one <run-id>"],
      [["harvest", "--driver", "fake", "qds-20260101-abcdef", "qds-20260101-abcdee"], "harvest takes exactly one <run-id>"],
    ];
    for (const [argv, message] of cases) {
      reset();
      const code = await runCli(argv, deps(validBriefJson(dir)));
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(message);
      expect(readdirSync(runsDir)).toHaveLength(0);
    }
  });

  test("--help in a value position is the typo it is, not a help request", async () => {
    // Resolved from the PARSED bools, so a --help that a value flag swallowed
    // never reaches the help branch: `--dir --help` used to print usage and exit
    // 0, and a CI script doing `fleet teardown … || alert` recorded success
    // while the box stayed live.
    for (const argv of [
      ["dispatch", "--brief", "--help"],
      ["teardown", "--driver", "fake", "--dir", "--help", "qds-20260101-abcdef"],
    ]) {
      reset();
      const code = await runCli(argv, {});
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain("requires a non-empty value");
      // Usage as a REMEDIATION inside the refusal envelope is fine; usage
      // printed to stdout is what a help request looks like, and this is not one.
      expect(outOnly).toHaveLength(0);
    }
    // An unknown verb with a genuine --help IS a help request: the help branch
    // runs before the registry lookup, so the operator who mistyped the verb
    // gets the verb list rather than a refusal that does not list them.
    reset();
    expect(await runCli(["not-a-verb", "--help"], {})).toBe(0);
    expect(outOnly.join("")).toBe(`${renderHelp(listVerbs())}\n`);
    expect(errCaptured).toHaveLength(0);
  });

  // ─── --driver is required on every verb (no silent fake) ───────────────────

  test("every verb refuses without --driver (exit 2), before reading a brief or a record", async () => {
    for (const argv of [["dispatch"], ["status"], ["harvest", "qds-20260101-abcdef"], ["teardown", "qds-20260101-abcdef"]]) {
      reset();
      const code = await runCli(argv, {});
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(`${argv[0] as string} requires --driver <name>`);
      // Refused before provisioning: no default runs dir, no default boxes dir.
      // These are the paths the CLI itself would build — $QDS_RUNS_DIR and
      // $QDS_FAKE_BOXES_DIR are redirected into this case's tmpdir by
      // `beforeEach`. Without that redirection the CLI resolved both relative to
      // the process cwd (the repo), so moving `assertDriverChosen` after
      // `new RunRecordStore(...)` littered the repo and both lines still passed.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
      expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
    }
  });

  test("an unknown --driver refuses — it never falls back to the fake driver", async () => {
    // The flag is inert in every test that injects `deps.driver`; this is the
    // one path where the CLI actually resolves it.
    const code = await runCli(["status", "--driver", "no-such-driver"], {});
    // 2, not 1: a driver name that is not in the registry is a permanent
    // operator error, and exit 1 is stamped `exitStatus: "transient"` — so
    // automation reading that field retried a typo forever. `asUsage` reclassifies
    // it while preserving resolveDriver's own message and remediation verbatim.
    expect(code).toBe(2);
    expect(text()).toContain("unknown provider driver: no-such-driver");
    expect(text()).toContain("registered:");
    expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
    // Refusals are diagnostics: they belong on the err sink, never on the stdout
    // an operator pipes into jq.
    expect(errCaptured.join("")).toContain("unknown provider driver");
    expect(outOnly).toHaveLength(0);
  });

  // ─── malformed brief → exit 2, zero provisioning (INV-2) ───────────────────

  test("unknown brief field → exit 2 naming the field, zero records, zero boxes", async () => {
    const bad = JSON.stringify({ ...JSON.parse(validBriefJson(dir)), extraField: 1 });
    const code = await runCli(["dispatch", "--driver", "fake"], deps(bad));
    expect(code).toBe(2);
    expect(text()).toContain("extraField");
    expect(readdirSync(runsDir)).toHaveLength(0);
    expectNoBoxes();
  });

  test("brief over 64 KiB → exit 2 brief-too-large naming the cap", async () => {
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"x".repeat(70_000)}`);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(big));
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(text()).toContain(String(MAX_BRIEF_BYTES));
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("a brief of EXACTLY 64 KiB is accepted (the cap is the limit, not one byte below it)", async () => {
    // Only the reject side was tested, so a `>=`/`>` flip — or a cap quietly
    // lowered to 8 KiB — refused every real brief and still passed.
    const brief = validBriefJson(dir);
    const padded = brief + " ".repeat(MAX_BRIEF_BYTES - Buffer.byteLength(brief, "utf8"));
    expect(Buffer.byteLength(padded, "utf8")).toBe(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(padded));
    expect(text()).not.toContain("brief-too-large");
    expect(code).toBe(0);
  });

  test("the cap counts BYTES, not UTF-16 code units", async () => {
    // 40 000 two-byte characters: 80 000 bytes, but `.length` sees ~40 000 and
    // would wave the brief through.
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"é".repeat(40_000)}`);
    expect(big.length).toBeLessThan(MAX_BRIEF_BYTES);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await runCli(["dispatch", "--driver", "fake"], deps(big));
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--brief <path> over 64 KiB → exit 2 brief-too-large, never invalid-brief", async () => {
    // Path-sourced oversize is refused by readBrief's stat BEFORE any JSON
    // parse — the catch must re-emit the FleetError, not relabel it.
    const bigPath = join(dir, "big-brief.json");
    writeFileSync(bigPath, "x".repeat(MAX_BRIEF_BYTES + 1));
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", bigPath], {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(text()).not.toContain("invalid-brief");
  });

  test("a --brief file of EXACTLY 64 KiB is accepted — the path reader has its own cap", async () => {
    // The 64 KiB cap has TWO independent enforcement sites: the stdin reader
    // (the OOM guard) and `readBriefFile`'s fstat. Only the reject side of the
    // path reader was covered, and its accept side was covered only through an
    // INJECTED `deps.readBrief` that replaces both — so a `>=`/`>` flip in
    // `readBriefFile`, or a cap quietly lowered there, refused every real
    // `--brief` an operator has and nothing in this file failed.
    const brief = validBriefJson(dir);
    const padded = brief + " ".repeat(MAX_BRIEF_BYTES - Buffer.byteLength(brief, "utf8"));
    expect(Buffer.byteLength(padded, "utf8")).toBe(MAX_BRIEF_BYTES);
    const path = join(dir, "at-cap.json");
    writeFileSync(path, padded);
    // `readBrief` deliberately NOT injected: --brief is the site under test.
    const { readBrief: _stdinReader, ...fromPath } = deps("");
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", path], fromPath);
    expect(text()).not.toContain("brief-too-large");
    expect(code).toBe(0);
  });

  test("--brief /dev/zero is refused as not a regular file, never read unbounded", async () => {
    // A character device reports size 0: the cap would be vacuous and the read
    // would never end. BOUNDED like the sibling hang-prone cases — the failure
    // this guards against IS a hang, and a hang must name itself rather than
    // die on the runner's global timeout with no attribution.
    const code = await within(
      "`fleet dispatch --brief /dev/zero`",
      30_000,
      runCli(["dispatch", "--driver", "fake", "--brief", "/dev/zero"], {}),
    );
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("not a regular file");
  });

  test("--brief <missing path> names the errno, not a JSON error", async () => {
    const code = await runCli(["dispatch", "--driver", "fake", "--brief", join(dir, "nope.json")], {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("ENOENT");
    expect(text()).not.toContain("invalid-brief");
  });

  test("a TRANSIENT errno while reading --brief is exit 1, never permanent exit 2 (round 10)", async () => {
    // FC5: readBriefFile wrapped every stat/open/read failure into the
    // permanent `brief-unreadable` exit-2 envelope. EMFILE/ENFILE/EAGAIN are
    // the SUBSTRATE running out of fds, classified retryable everywhere else
    // in this CLI (RETRYABLE_ERRNOS / asUsage) — so they must surface as exit
    // 1 `transient`, not tell automation to never retry a condition that is
    // gone as soon as one fd closes.
    const briefPath = join(dir, "transient-brief.json");
    writeFileSync(briefPath, validBriefJson(dir), { mode: 0o600 });
    const hoard: number[] = [];
    try {
      // Exhaust the fd table until the OS refuses. The soft limit here is
      // six figures, so the bound is a DEADLINE (a platform that never
      // refuses fails THIS test loudly) rather than an fd count.
      const deadline = Date.now() + 30_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("could not provoke EMFILE within 30s of hoarding");
        try {
          hoard.push(openSync("/dev/null", "r"));
        } catch (e) {
          expect((e as NodeJS.ErrnoException).code).toBe("EMFILE");
          break;
        }
      }
      // The path itself stats fine (path-based syscall, no fd); it is the OPEN
      // that hits the exhausted table and must now rethrow raw.
      const code = await runCli(["dispatch", "--driver", "fake", "--brief", briefPath], {});
      expect(code).toBe(1);
      const envelope = JSON.parse(errCaptured.find((l) => l.includes("EMFILE")) as string) as { code: string };
      expect(envelope.code).toBe("EMFILE");
      expect(errCaptured.join("")).not.toContain("brief-unreadable");
    } finally {
      for (const fd of hoard) closeSync(fd);
    }
  });

  test("--brief AND a brief redirected onto stdin is refused; /dev/null stdin is not", async () => {
    // `fleet dispatch --brief old.json < new.json` provisioned from old.json and
    // said nothing — the same "acting on something other than what the operator
    // saw themselves type" this CLI refuses `--dir` twice for, except the
    // outcome is a billable box built from the wrong brief.
    //
    // Out of process, because the guard tests fd 0's TYPE and `deps.readBrief`
    // replaces the whole reader. The BRIEF IS DELIBERATELY MALFORMED, so the two
    // outcomes separate by CODE rather than by exit status: the source check
    // runs before `readBriefFile`, so `brief-unreadable`/`invalid-brief` is
    // positive proof the file was reached and the guard did not fire.
    const briefPath = join(dir, "one-source.json");
    writeFileSync(briefPath, "{not json");
    const q = (s: string): string => JSON.stringify(s);

    // What fd 0 actually IS, reported by a child spawned exactly as the CLI
    // below is. Every row asserts this first, so a harness change that stops
    // producing the type the row names fails the test instead of passing it
    // vacuously — which is precisely how the socket row went missing: the
    // original spelling of it used `Bun.spawn({stdin: <Buffer>})`, believed it
    // was making a pipe, and was making a socket the guard never looked at.
    const probe = join(dir, "fd0-probe.ts");
    writeFileSync(
      probe,
      `import { fstatSync } from "node:fs";
let t = "closed"; // fstat throws EBADF on a closed fd 0
try {
  const s = fstatSync(0);
  t = s.isSocket() ? "socket" : s.isFIFO() ? "fifo" : s.isFile() ? "file" : s.isCharacterDevice() ? "chardev" : "other";
} catch {}
process.stdout.write(t);
`,
    );

    // Two ways to produce fd 0, used DELIBERATELY and not interchangeably:
    //
    //  - `Bun.spawn({stdin: "pipe"})` gives a SOCKET. Bun (and Node) back their
    //    "pipe" stdio with a socketpair, so this is what every programmatic
    //    parent hands a child — and it was the hole: the guard used to test
    //    `isFIFO() || isFile()`, so `fleet dispatch --brief old.json` under any
    //    such parent silently provisioned from the wrong brief.
    //  - `sh -c` gives a real FIFO (`cat x |`), a real regular file (`< f`), a
    //    character device (`< /dev/null`) or no fd 0 at all (`0<&-`). Nothing
    //    else produces those.
    //
    // The guard is now an ALLOW-list — `if (st.isCharacterDevice()) return;`
    // plus the EBADF catch — so a stdio type nobody has thought of yet is
    // refused rather than waved through, which an enumerated deny-list could
    // not promise.
    type Spawn = (cmd: string[]) => Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
    const viaSocket: Spawn = (cmd) => Bun.spawn(cmd, { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const viaShell =
      (wrap: (c: string) => string): Spawn =>
      (cmd) =>
        Bun.spawn(["sh", "-c", wrap(`exec ${cmd.map(q).join(" ")}`)], {
          cwd: dir,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });

    const cases: [string, string, Spawn, boolean][] = [
      ["a socket on stdin", "socket", viaSocket, true],
      ["a pipe on stdin", "fifo", viaShell((c) => `cat ${q(briefPath)} | ${c}`), true],
      ["a redirected regular file", "file", viaShell((c) => `${c} < ${q(briefPath)}`), true],
      // LOAD-BEARING, do not "simplify" to an isTTY check: cron, systemd and
      // every container give a non-interactive process /dev/null on fd 0 and no
      // tty, so `!isTTY` would refuse every non-interactive `--brief` invocation
      // there is. Testing fd 0's TYPE is the whole reason that works, and this
      // row is what fails when someone swaps it back.
      ["/dev/null on stdin", "chardev", viaShell((c) => `${c} < /dev/null`), false],
      // The guard's other allow arm — no fd 0 at all, `fstatSync(0)` throws
      // EBADF — is NOT here: `bun` reopens a closed fd 0 on /dev/null before
      // user code runs (measured: `sh -c 'exec bun probe 0<&-'` reports
      // chardev), so it is unreachable from any test that runs under bun and a
      // row for it would only re-assert the /dev/null row above.
    ];

    const fleetArgv = [
      "bun",
      join(import.meta.dir, "../../scripts/fleet.ts"),
      "dispatch",
      "--driver",
      "fake",
      "--brief",
      briefPath,
    ];

    for (const [label, fd0Type, spawn, refusedAsTwoSources] of cases) {
      // 1. the premise: fd 0 really is what this row claims.
      const probed = spawn(["bun", probe]);
      try {
        const [, said] = await within(
          `the fd 0 probe for ${label}`,
          30_000,
          Promise.all([probed.exited, readCapped(probed.stdout)]),
        );
        expect({ label, fd0: said }).toEqual({ label, fd0: fd0Type });
      } finally {
        probed.kill("SIGKILL");
        await probed.exited;
      }

      // 2. the claim. The brief is DELIBERATELY malformed, so the two outcomes
      // separate by CODE rather than by exit status — both exit 2. The source
      // check runs before `readBriefFile`, so `invalid-brief` is positive proof
      // the file was reached and the guard did not fire.
      const proc = spawn(fleetArgv);
      try {
        const [code, stdout, stderr] = await within(
          `fleet dispatch --brief with ${label}`,
          30_000,
          Promise.all([proc.exited, readCapped(proc.stdout), readCapped(proc.stderr)]),
        );
        expect({ label, code }).toEqual({ label, code: 2 });
        expect({ label, stdout }).toEqual({ label, stdout: "" });
        expect({
          label,
          twoSources: stderr.includes("was given AND a brief was redirected onto stdin"),
        }).toEqual({ label, twoSources: refusedAsTwoSources });
        // The other side of the same claim: refused as two sources means the
        // file was never read; not refused means it WAS.
        expect({ label, read: stderr.includes("invalid-brief") }).toEqual({ label, read: !refusedAsTwoSources });
        if (refusedAsTwoSources) {
          expect(stderr).toContain("pass the brief exactly one way: `--brief <path>`, or on stdin with no --brief");
        }
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    // 4 cases × (probe + dispatch), each bounded at 30s: the outer budget has to
    // clear the SUM, or the runner's timeout fires first and masks the NAMED
    // hang this test's `within`s exist to produce.
  }, 300_000);

  test("invalid JSON brief → exit 2", async () => {
    const code = await runCli(["dispatch", "--driver", "fake"], deps("{not json"));
    expect(code).toBe(2);
    expect(text()).toContain("invalid-brief");
  });

  test("the decoded-brief byte cap binds even when the brief legitimately contains U+FFFD (round 10)", async () => {
    // FC8: the old re-measure was skipped whenever the decoded text CONTAINED
    // U+FFFD — which cannot tell a corrupt byte from a legitimate one, so a
    // brief whose content includes a real replacement character bypassed the
    // cap's second enforcement site entirely. Measured unconditionally now:
    // a legit U+FFFD round-trips (3 bytes in, 3 out), so at-cap is accepted
    // and over-cap refused, exactly as for any other content. The char rides
    // INSIDE a string value and the padding is trailing whitespace, so both
    // rows are valid JSON — the refusal can only be the cap's.
    const base = validBriefJson(dir);
    // requestId is the schema's deliberately-LOOSE string (no format rule), so
    // a legit U+FFFD there survives BriefSchema and the accept row proves the
    // MEASURE released the brief — not that a schema refusal coincidentally
    // shares exit 2.
    const withFffd = base.replace(',"manifestPath":', ',"requestId":"corr-\u{FFFD}id","manifestPath":');
    expect(withFffd).not.toBe(base); // the injection really happened
    // \u{FFFD} encodes as exactly 3 UTF-8 bytes.
    const atCap = `${withFffd}${" ".repeat(MAX_BRIEF_BYTES - Buffer.byteLength(withFffd, "utf8"))}`;
    expect(Buffer.byteLength(atCap, "utf8")).toBe(MAX_BRIEF_BYTES);
    const over = `${atCap} `;
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_BRIEF_BYTES + 1);

    reset();
    expect(
      await runCli(["dispatch", "--driver", "fake"], { ...deps(atCap) }),
    ).toBe(0);

    reset();
    expect(
      await runCli(["dispatch", "--driver", "fake"], { ...deps(over) }),
    ).toBe(2);
    expect(text()).toContain("brief-too-large");
  });

  test("`yes | fleet dispatch` hits brief-too-large immediately instead of buffering to OOM", async () => {
    // The one path that must refuse AS IT STREAMS; an in-process test cannot
    // see it, because `deps.readBrief` replaces the stdin reader entirely.
    // `exec` in the last pipeline element, so `proc.pid` IS the CLI rather than
    // the wrapping `sh`. Without it `proc.kill` signalled the shell and left
    // `yes` writing into a pipe nobody closed — one leaked spinning process per
    // run of this file.
    const proc = Bun.spawn(
      [
        "sh",
        "-c",
        `yes | exec bun ${JSON.stringify(join(import.meta.dir, "../../scripts/fleet.ts"))} dispatch --driver fake`,
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    try {
      // BOUNDED, and the reads are capped. If the streaming cap regresses —
      // which is this test's entire subject — the CLI buffers `yes` forever and
      // an unbounded `await proc.exited` hangs until the runner's global
      // timeout kills the whole file with no attribution. The failure has to
      // name itself.
      const [code, stdout, stderr] = await within(
        "`yes | fleet dispatch`",
        30_000,
        Promise.all([proc.exited, readCapped(proc.stdout), readCapped(proc.stderr)]),
      );
      expect(code).toBe(2);
      expect(stderr).toContain("brief-too-large");
      expect(stdout).toBe(""); // stdout carries output only
      // Refused before provisioning: nothing was created under the cwd.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    // Above the 30s `within` bound: the runner's timeout must never be what
    // ends this test, or the named "did not finish within" never surfaces.
  }, 60_000);

  test("the STDIN reader enforces the cap on both sides of the boundary, out of process", async () => {
    // `yes |` above is the gross case: an infinite producer, refused as it
    // streams. The BOUNDARY is a different mutation — a `>=`/`>` flip, or a cap
    // read from the wrong constant — and it is invisible in-process, because
    // `deps.readBrief` replaces the stdin reader entirely and every in-process
    // boundary case in this file goes through that injection. This is the one
    // enforcement site an operator's `cat brief.json | fleet dispatch` actually
    // hits, and it is the OOM guard.
    const brief = validBriefJson(dir);
    const atCap = brief + " ".repeat(MAX_BRIEF_BYTES - Buffer.byteLength(brief, "utf8"));
    expect(Buffer.byteLength(atCap, "utf8")).toBe(MAX_BRIEF_BYTES);
    const fleetPath = join(import.meta.dir, "../../scripts/fleet.ts");
    // Credential-stripped env, deliberately NOT inherited wholesale. The accept
    // row drives a REAL scripts/fleet.ts with a VALID brief, so on a host that
    // exports $OPENROUTER_PROVISIONING_KEY — a normal .env state — it would
    // otherwise complete a full dispatch and mint a LIVE credentialed key while
    // the row passed silently; on hosts without the variable the same row
    // passed by a different route (provisioning-key-missing). Stripping it makes
    // both rows deterministic everywhere: `openRouterKeyApi()` refuses at
    // construction, before any side effect, and the accept row's claim is still
    // exercised — a brief AT the cap got through the reader without being named
    // brief-too-large.
    const { OPENROUTER_PROVISIONING_KEY: _provKey, ...childEnv } = process.env;

    for (const [label, payload, refused] of [
      ["exactly the cap", atCap, false],
      ["one byte over", `${atCap} `, true],
    ] as const) {
      const proc = Bun.spawn(["bun", fleetPath, "dispatch", "--driver", "fake"], {
        cwd: dir,
        env: childEnv,
        stdin: Buffer.from(payload, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const [code, stdout, stderr] = await within(
          `fleet dispatch with a brief of ${label}`,
          30_000,
          Promise.all([proc.exited, readCapped(proc.stdout), readCapped(proc.stderr)]),
        );
        // BOTH rows exit 2 — the cap refusal and the key refusal share the
        // envelope shape — and stdout stays empty in both. Asserting them on the
        // accept side too is what stops a crash-shaped 1, or a wedged success,
        // from passing as "the cap was not hit".
        expect({ label, code }).toEqual({ label, code: 2 });
        expect({ label, stdout }).toEqual({ label, stdout: "" });
        expect({ label, refused: stderr.includes("brief-too-large") }).toEqual({ label, refused });
        if (refused) {
          expect(stderr).toContain(String(MAX_BRIEF_BYTES));
        } else {
          // Accepted THROUGH the reader, then stopped cold before the mint: the
          // refusal names the missing provisioning key and nothing else was
          // provisioned — the store's dir exists but holds no record (it is
          // built before the client, per fleet.ts's INV ordering), and no box
          // root was ever created.
          expect(stderr).toContain("OPENROUTER_PROVISIONING_KEY is not set");
          expect(readdirSync(join(dir, ".sandbox", "runs"))).toHaveLength(0);
          expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
        }
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    // Two rows × 30s each: the outer budget clears the SUM of the inner bounds.
  }, 90_000);

  // ─── --port grammar and the ack's httpsUrl ─────────────────────────────────

  test("--port must be a TCP port → exit 2, nothing provisioned", async () => {
    // The last four are Number()'s own vocabulary, not the operator's: `0x1f4`,
    // `1e3`, `" 8080 "` and `08080` are each an integer in 1-65535 by the time
    // Number() is done with them, and none is the port that was typed. The
    // `/^[1-9]\d{0,4}$/` pre-check is what refuses them.
    for (const bad of ["abc", "0", "65536", "8080.5", "-1", "0x1f4", "1e3", " 8080 ", "08080"]) {
      reset();
      const code = await runCli(["dispatch", "--driver", "fake", "--port", bad], deps(validBriefJson(dir)));
      expect({ bad, code }).toEqual({ bad, code: 2 });
      expect(text()).toContain("is not a TCP port");
      expect(readdirSync(runsDir)).toHaveLength(0);
      expectNoBoxes();
    }
    // An empty value is refused by the flag parser, one step earlier — same
    // exit, different (and more accurate) message.
    reset();
    expect(await runCli(["dispatch", "--driver", "fake", "--port", ""], deps(validBriefJson(dir)))).toBe(2);
    expect(text()).toContain("--port requires a non-empty value");
  });

  test("both ends of the port range are ACCEPTED (1 and 65535 are legal ports)", async () => {
    // Only the reject side was covered, so tightening the guard to `<= 1 ||
    // >= 65_535` refused two legal ports with nothing failing — the mirror of
    // the exact-limit accept case the 64 KiB cap already has.
    for (const port of ["1", "65535"]) {
      reset();
      const shared = deps(validBriefJson(dir));
      const code = await runCli(["dispatch", "--driver", "fake", "--port", port], shared);
      expect({ port, code }).toEqual({ port, code: 0 });
      const ack = JSON.parse(outOnly.find((l) => l.includes("runId")) as string) as { vmName: string; httpsUrl?: string };
      expect(ack.httpsUrl).toBe(`https://${ack.vmName}-${port}.fake.local`);
    }
  });

  test("--port <n> exposes the box and the ack carries its httpsUrl", async () => {
    const shared = deps(validBriefJson(dir));
    const code = await runCli(["dispatch", "--driver", "fake", "--port", "8080"], shared);
    expect(code).toBe(0);
    const ack = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.httpsUrl).toBe(`https://${ack.vmName}-8080.fake.local`);
    // The exposure is on the record too — `fleet status` is the only surface an
    // operator has for it.
    const record = (shared.store as RunRecordStore).get(ack.runId);
    expect(record.httpsUrl).toBe(ack.httpsUrl);
    expect(record.ports).toEqual([8080]);
  });

  // ─── the exit-code table (F3): 3 gate, 4 not-found, 5 refused ──────────────

  test("setup-gate failure → exit 3 with the assertion code, box ALIVE and record OPEN (INV-5)", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = {
      ...deps(validBriefJson(dir)),
      // Item A of the gate is `exec true`; failing it fails the gate without
      // touching the mint, the delivery or the fill.
      driver: driverWith(base, {
        exec: async (vm: string, argv: string[], stdin?: string) =>
          argv[0] === "true"
            ? { exitCode: 1, stdout: "", stderr: "box unreachable" }
            : base.exec(vm, argv, stdin),
      }),
    };
    const code = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(code).toBe(3);
    // Per-stream, not merged `captured` — here and on every row/envelope read
    // below that switched with it: these are DIAGNOSTICS, and reading them off
    // the merge holds just as well if printError wrote them onto stdout, which
    // is precisely the regression (`fleet … | jq`) nothing else here would
    // catch. The ack/row reads use `outOnly`, the envelope reads `errCaptured`.
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("setup-gate-failed")) as string) as {
      code: string;
      assertionCode: number;
      failedItem: string;
      runId: string;
      vmName: string;
      teardownCommand: string;
    };
    expect(envelope.code).toBe("setup-gate-failed");
    expect(envelope.failedItem).toBe("A");
    expect(envelope.assertionCode).toBe(1);
    expect(envelope.teardownCommand).toContain(envelope.runId);
    // INV-5: the evidence survives the refusal.
    expect((await base.list()).map((vm) => vm.name)).toContain(envelope.vmName);
    expect((shared.store as RunRecordStore).get(envelope.runId).closedAt).toBeUndefined();
  });

  test("an over-budget issue → exit 5 refused BEFORE provisioning (AC7)", async () => {
    // The RECORDING ledger from ./helpers.ts, not a local look-alike: the real
    // one owns a SQLite handle, and a refusal that returns without closing it
    // leaks one per invocation — invisible to every assertion below.
    const ledger = overBudgetLedger();
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), ledgerFactory: () => ledger };
    const code = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(code).toBe(5);
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("budget-exceeded")) as string) as {
      code: string;
      capMicroUsd: number;
      spentMicroUsd: number;
    };
    expect(envelope.code).toBe("budget-exceeded");
    expect(envelope.capMicroUsd).toBe(10_000_000);
    expect(envelope.spentMicroUsd).toBe(12_000_000);
    expect(readdirSync(runsDir)).toHaveLength(0);
    expectNoBoxes();
  });

  // ─── the run-id grammar: exit 2 before any path is built ───────────────────

  test("a run id that fails the grammar is refused with invalid-run-id, on every verb that takes one", async () => {
    // `assertFleetRunId` is the single fleet-side enforcement point (its own
    // docstring says so) and the ONLY thing between an operator-supplied
    // positional and `<store.dir>/<runId>.json` / `.lock`. Every other id in
    // this file is well-formed and reaches the store as exit 4, so deleting
    // either call site left the suite green while `fleet teardown ../../secrets`
    // became a path-traversal read and unlink.
    //
    // `a`×64 is the LENGTH cap on its own: it satisfies RUN_ID_RE completely,
    // so it is the only id here that `RUN_ID_MAX` alone refuses. Every other
    // bad id fails a character rule too — `"Q"×300` is rejected on the
    // uppercase rule before its length is ever consulted — which made deleting
    // the `id.length > RUN_ID_MAX` check a green mutation.
    //
    // `"Q"×300` is the UNBOUNDED-ECHO case, and its envelope is now pinned as a
    // literal rather than by parts. The CLI's own 96-char pre-cap was removed so
    // there is exactly ONE bound on the echo and it lives at the sink that owns
    // the message (`assertFleetRunId` in src/fleet/dispatch.ts): capping first
    // handed the store a 108-char string to describe, so the envelope carried
    // two lengths that contradicted each other, and a secret pasted into the
    // run-id position could be cut across the boundary into two halves neither
    // redaction rule matches. What survives is a 12-char head, escaped, plus the
    // TRUE length — and the store's own echo of the whole id is eaten whole by
    // `redactSecrets`' opaque-token rule, which is the right answer: it tells
    // the operator they pasted a secret without repeating any of it.
    const LONG_ID = "Q".repeat(300);
    const LONG_ID_MESSAGE =
      'invalid run id: "«redacted»" (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars)' +
      ' — supplied: "QQQQQQQQQQQQ…" (300 chars)';
    const badIds = ["../evil", "a/b", "", LONG_ID, "a".repeat(64), "qds-x/../y", "qds-20260101-ABCDEF"];
    for (const verb of ["status", "harvest", "teardown"]) {
      for (const runId of badIds) {
        reset();
        const code = await runCli([verb, "--driver", "fake", "--dir", runsDir, runId], deps(validBriefJson(dir)));
        expect({ verb, runId, code }).toEqual({ verb, runId, code: 2 });
        const envelope = JSON.parse(errCaptured[0] as string) as {
          code: string;
          message: string;
          remediation: string;
        };
        expect(envelope.code).toBe("invalid-run-id");
        if (runId === "") {
          // EXACT, not `toContain(JSON.stringify(""))`: `'""'` matches any
          // message containing two adjacent quotes, which is all of them. This
          // is also the only row short enough that `runIdSupplied` adds no
          // "— supplied" suffix, so pinning it verbatim proves the message is
          // built from the raw argument rather than from a placeholder.
          expect(envelope.message).toBe(
            'invalid run id: "" (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars)',
          );
        } else if (runId === LONG_ID) {
          // VERBATIM, not `toContain` of the pieces: every part of this string
          // is load-bearing and each was independently wrong at some point —
          // the head length, the escaping, the redaction of the store's echo,
          // and which of the two lengths gets reported.
          expect(envelope.message).toBe(LONG_ID_MESSAGE);
          expect(envelope.remediation).toBe("run ids come from `fleet dispatch`; list them with `fleet status`");
          // Whatever else changes, the id itself never rides out whole.
          expect(errCaptured.join("")).not.toContain(runId);
        } else if (runId.length > 12 /* RUN_ID_ECHO_CHARS */) {
          // Cross-cluster update (round 10): dispatch.ts's `runIdEcho` now
          // truncates EVERY over-12-char rejection — head plus TRUE length,
          // spliced over the store's own verbatim echo — where it used to
          // bound only the band under redactSecrets' 40-char floor. So no
          // long id rides out whole anywhere (`a`×64, which fails only the
          // cap, lands here too), and only ids of twelve characters or fewer
          // keep the verbatim echo in the final branch.
          expect(envelope.message).not.toContain(runId);
          expect(envelope.message).toBe(
            `invalid run id: "${runId.slice(0, 12)}…" (${runId.length} chars) (must match ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ and be <= 63 chars)`,
          );
        } else {
          expect(envelope.message).toContain(JSON.stringify(runId));
        }
        // Refused before the store, the lock and the driver: nothing on disk.
        expect(readdirSync(runsDir)).toHaveLength(0);
        expect(existsSync(join(dir, "evil"))).toBeFalse();
      }
    }
    // …and the cap really is the reason `a`×64 was refused: one character
    // shorter is a legal id, which reaches the store and answers exit 4.
    reset();
    expect(await runCli(["status", "--driver", "fake", "--dir", runsDir, "a".repeat(63)], deps(""))).toBe(4);
    expect(errCaptured.join("")).not.toContain("invalid-run-id");
  });

  test("a LEGAL id inside redaction's ≥40-char band rides run-not-found VERBATIM, whatever its shape", async () => {
    // The band the grammar test above only sees from the REJECTED side: an id of
    // 40–63 chars passes RUN_ID_RE, so it never meets `runIdEcho`'s bounded,
    // redaction-composed echo — it reaches the store and comes back through the
    // TYPED FleetError branch of `report`, whose messages are composed redacted
    // at their source and are printed as-is (`printError` deliberately does not
    // re-redact). Pinned as INTENT on both shapes the sink could meet:
    //
    //  - digest-shaped (hex with a-f letters): verbatim BY DESIGN. Legal ids are
    //    dispatch-minted operator data, and `redactSecrets`' long-token arm
    //    exempts hex digests precisely so SHAs stay readable everywhere else —
    //    a run id named after one must not be eaten where those survive.
    //  - opaque-shaped: STILL verbatim here, and that is the honest pin, not an
    //    oversight to hide: the eaten-whole treatment is a property of the
    //    GRAMMAR GATE for rejected arguments (the LONG_ID row above), and this
    //    path has no second gate to hide behind. If that ever stops being the
    //    accepted residual, this line goes red and the fix belongs in the
    //    envelope's composer — not in a test-side redaction that would leave
    //    every other typed message unguarded.
    const shaShaped = "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff0"; // 63 hex chars
    const opaque = "q9r8s7t6u4v3w5x2y1z0a9b8c7d6e5f4g3h2j1k9l8m7n6p5q4r3s2t1u0v9w"; // 61 chars, non-hex
    expect(shaShaped).toMatch(/^[0-9a-f]{63}$/);
    expect(opaque.length).toBeGreaterThanOrEqual(40);
    expect(opaque).toMatch(/^[a-z0-9-]+$/);
    for (const runId of [shaShaped, opaque]) {
      reset();
      expect(await runCli(["status", "--driver", "fake", "--dir", runsDir, runId], deps(""))).toBe(4);
      const envelope = JSON.parse(errCaptured.find((l) => l.includes("run-not-found")) as string) as {
        code: string;
        message: string;
      };
      expect(envelope.code).toBe("run-not-found");
      // WHOLE, in the sentence — the operator asked about THIS id by name.
      expect(envelope.message).toContain(`No run record for ${runId}`);
    }
  });

  // ─── status unknown run → exit 4, mutates nothing (AC4) ────────────────────

  test("status <unknown-runId> → exit 4 run-not-found, driver consulted but nothing mutated", async () => {
    const driver = new FakeDriver(boxesDir);
    // Bind BEFORE overwriting: reading driver.list inside the mock after the
    // reassignment would recurse into the mock itself.
    const originalList = driver.list.bind(driver);
    const listSpy = mock(() => originalList());
    driver.list = listSpy;
    const d = deps(validBriefJson(dir));
    (d as { driver?: FakeDriver }).driver = driver;
    const code = await runCli(["status", "qds-19990101-000000"], d);
    expect(code).toBe(4);
    expect(text()).toContain("run-not-found");
    // A missing record is NOT proof the box is gone (statusAll would call the
    // same box `orphan`), so statusRun probes the driver before refusing —
    // exactly once, and only then does exit 4 mean "no record AND no box".
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("status on a live box whose record is gone → exit 0 orphan, never exit 4", async () => {
    // The other half of the probe above, and the reason it exists: record and
    // box are separately losable. Exiting 4 here denies the existence of a box
    // that is alive and spending — the one query an operator types when they
    // already know the run id.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };
    rmSync(join(runsDir, `${runId}.json`));

    reset();
    expect(await runCli(["status", "--driver", "fake", runId], shared)).toBe(0);
    // Rows are OUTPUT: stdout only, so the orphan path is held to the same
    // stdout-purity contract as the acks.
    const row = JSON.parse(outOnly[0] as string) as { runId: string; state: string; vmName: string };
    // An orphan row's `runId` is a LABEL, not an id: there is no record, so
    // nothing attributes the box to a run, and a bare id in that column reads
    // as a record that exists. `vmName` is the box the operator must act on and
    // is unchanged.
    expect(row).toMatchObject({ runId: `(orphan ${vmName})`, state: "orphan", vmName });
    // …and the label is deliberately outside the id grammar, so `fleet status |
    // jq -r .runId | xargs fleet teardown` cannot feed it back as one.
    expect(RUN_ID_RE.test(row.runId)).toBeFalse();
  });

  test("teardown <unknown-runId> → exit 4 run-not-found, refused BEFORE the lock", async () => {
    // The records directory is removed after the store is built, which makes
    // the ORDERING visible instead of merely plausible. A post-hoc "no .lock
    // file remains" scan cannot tell the two orders apart: it is satisfied by
    // the probe-then-lock order the source comment mandates AND by the
    // lock-discover-release order it exists to forbid — the one that strands a
    // phantom `<runId>.lock` for a run that never existed when a crash lands in
    // between. With the directory gone, `store.get` is still ENOENT → exit 4,
    // but `acquireRunLock` cannot create its temp there: a lock-first order
    // throws ENOENT out of `claim` and reports a retryable exit 1.
    const gone = join(dir, "vanished-runs");
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), store: new RunRecordStore(gone) };
    rmSync(gone, { recursive: true, force: true });

    const code = await runCli(["teardown", "--driver", "fake", "qds-19990101-000000"], shared);
    expect(code).toBe(4);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string };
    expect(envelope.code).toBe("run-not-found");
    // Nothing was created for a run that does not exist: not the directory, not
    // a lock, not a temp.
    expect(existsSync(gone)).toBeFalse();
  });

  // ─── harvest: the fourth verb, and the only credential-free one (D8) ───────

  test("e2e: dispatch → harvest → teardown, with harvest taking and releasing the run lock", async () => {
    // `harvest` had no functional test at all: it appeared only in the verb
    // list, the bare-verb exit table and the --driver loop. Inverting the
    // `outcome === "harvested"` ternary, printing the wrong count, or dropping
    // the lock release all shipped green.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], {
      ...shared,
      // D8: harvest builds no keyApi. `deps.keyApi` is deliberately consulted
      // only by teardown, so a harvest that starts reaching for credentials —
      // openRouterKeyApi() included — must fail loudly rather than quietly grow
      // a provisioning-key requirement the verb does not have.
      keyApi: keyApiTripwire(),
    });

    expect(code).toBe(0);
    // The fake box holds no git repo, so the bundle protocol answers NOREPO and
    // the outcome is the "none" arm. Pinned exactly: a count printed through the
    // wrong arm reads `harvested: undefined`.
    expect(outOnly.join("")).toBe("harvested: none\n");
    expect(errCaptured).toHaveLength(0);
    // The same per-run lock the teardown cases prove, released on the way out —
    // a harvest that leaks it locks the run against its own teardown.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
    // Harvest is non-destructive: the record stays open and the box stays alive,
    // which is what makes the teardown below the proof that harvest left the run
    // operable rather than merely quiet.
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
  });

  test("a harvest whose box answers the bundle protocol prints the COUNT-bearing line", async () => {
    // Every other harvest case here lands on "harvested: none" — the fake box
    // holds no git repo, so step A always answers NOREPO — and the ternary's
    // OTHER arm, `harvested: ${res.count}`, shipped untested: printing through
    // the wrong arm (`harvested: undefined`), or a count that was never the
    // box's, passed green. Driving the OK arm takes three real pieces: a
    // canned step-A protocol line, a GENUINE bundle for steps C/D to verify
    // and fetch, and a host repo for them to land in.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(outOnly.find((l) => l.includes("runId")) as string) as { runId: string };

    // Steps C and D run real git against gitCwd, which the CLI pins to
    // process.cwd() at call time — so this case chdirs into a THROWAWAY repo
    // for the duration instead of fetching refs/sandbox/<id> into whatever
    // checkout launched the suite. Restored in finally; the repo is deleted.
    const hostRepo = mkdtempSync(join(tmpRoot, "harvest-host-"));
    // POSIX-precondition isolation for hosts whose global git config signs or
    // hooks commits: `-c commit.gpgsign=false` keeps a gpg-signing checkout from
    // failing (or PASSPHRASE-PROMPTING, which reads as a hang) on the one commit
    // this case makes, and the ident env spares hosts with no global
    // user.name/email. Nothing here depends on signing or hooks.
    const git = (args: string[]): void => {
      const r = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
        cwd: hostRepo,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fleet test",
          GIT_AUTHOR_EMAIL: "fleet-test@example.invalid",
          GIT_COMMITTER_NAME: "fleet test",
          GIT_COMMITTER_EMAIL: "fleet-test@example.invalid",
        },
      });
      if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`);
    };
    git(["init", "-q"]);
    git(["config", "user.email", "fleet-test@example.invalid"]);
    git(["config", "user.name", "fleet test"]);
    writeFileSync(join(hostRepo, "work.txt"), "one\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "one"]);
    // The fetch refspec names THIS run's quarantine branch, so the bundle must
    // carry a ref under exactly that name.
    git(["branch", `sbx/${runId}`]);
    const tip = Bun.spawnSync(["git", "rev-parse", `sbx/${runId}`], { cwd: hostRepo, stdout: "pipe" })
      .stdout.toString()
      .trim();
    // Full-history bundle: no prerequisite commits, so `bundle verify` passes
    // in the throwaway repo whatever base dispatch pinned into the record.
    const bundlePath = join(hostRepo, "harvest.bundle");
    git(["bundle", "create", bundlePath, `sbx/${runId}`]);
    const bytes = String(statSync(bundlePath).size);

    // dispatch gates ON the brief's commitSha but never persists it into the
    // record, and harvestRun answers "none" without one (`!rec.commitSha`) —
    // the same early-out the no-repo cases take. Pinned through the file like
    // every other record mutation here.
    const recordPath = join(runsDir, `${runId}.json`);
    writeFileSync(
      recordPath,
      JSON.stringify({ ...JSON.parse(readFileSync(recordPath, "utf8") as string), commitSha: tip }),
      { mode: 0o600 },
    );

    // Step A answered HERE, not by any box: the canned protocol line carries
    // the count — deliberately NOT the repo's commit count, because the pin is
    // that the CLI prints res.count verbatim, not that the number means
    // anything specific. Everything else delegates to the real FakeDriver, so
    // the artifacts step still answers NOARTIFACTS and stays quiet.
    const base = shared.driver as FakeDriver;
    const okDriver = driverWith(base, {
      exec: async (vm: string, argv: string[], stdin?: string) =>
        argv[0] === "bash" && argv[1] === "-s" && argv[2] === "--"
          ? { exitCode: 0, stdout: `OK ${tip} 2 ${bytes}\n`, stderr: "" }
          : base.exec(vm, argv, stdin),
      copyFile: async (vm: string, remotePath: string, localPath: string) => {
        // Scoped to the bundle: pullArtifacts copies through this seam too,
        // and handing IT bundle bytes would fail tar validation and fail the
        // verb for a reason nothing here is testing.
        if (remotePath !== "harvest.bundle") return base.copyFile(vm, remotePath, localPath);
        copyFileSync(bundlePath, localPath);
      },
    });

    const originalCwd = process.cwd();
    try {
      process.chdir(hostRepo);
      reset(); // the dispatch ack is still in the captures; this case reads the harvest line only
      const code = await within(
        "the OK-protocol harvest",
        30_000,
        runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], { ...shared, driver: okDriver }),
      );
      expect(code).toBe(0);
      // THE arm, pinned byte for byte — not `toContain`, which a stray progress
      // line or the none-arm's text could satisfy.
      expect(outOnly.join("")).toBe("harvested: 2\n");
      expect(errCaptured).toHaveLength(0);
      // The bundle came down (its presence IS the harvest record) and the lock
      // came back off, so the run stays operable.
      expect(existsSync(join(runsDir, `${runId}.bundle`))).toBeTrue();
      expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
      // …and the quarantine ref landed in the THROWAWAY repo — proof gitCwd
      // followed the chdir rather than fetching into the suite's own checkout.
      expect(
        Bun.spawnSync(["git", "rev-parse", "--verify", `refs/sandbox/${runId}`], { cwd: hostRepo }).exitCode,
      ).toBe(0);
    } finally {
      // PARALLEL-FILE RISK, contained: `bun test` may run this file's cases
      // interleaved with other suites in the same PROCESS, and process.cwd() is
      // process-global — a case left behind here would resolve every later
      // cwd-relative default (the containment-root refusal pins one) against a
      // deleted throwaway repo. The restore is therefore guarded: it fires even
      // on assertion failures mid-case (this `finally`), and only moves back
      // when something actually moved away.
      if (process.cwd() !== originalCwd) process.chdir(originalCwd);
      rmSync(hostRepo, { recursive: true, force: true });
    }
  });

  // ─── the shared per-run lock (scripts/lib/run-lock.ts) on the teardown verb ─

  test("teardown takes the shared run lock: a held lock refuses and mutates nothing", async () => {
    const shared = deps(validBriefJson(dir));
    const store = shared.store as RunRecordStore;
    const driver = shared.driver as FakeDriver;
    const dispatchCode = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(dispatchCode).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    // A concurrent teardown's lock. If `fleet teardown` stopped acquiring it,
    // two invocations would double-destroy the box and double-write the spend.
    //
    // The holder pid is a child this case OWNS and keeps alive for the duration
    // — not `process.pid + 1`, which is whatever the OS happened to hand out
    // next and is dead on most runs. A dead "live holder" makes this the stale
    // case in disguise, and the live/stale remediation split below (the only
    // thing that distinguishes the two branches, since their MESSAGE is
    // identical) then asserts nothing.
    const alive = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const holder = alive.pid;
    const lock = join(runsDir, `${runId}.lock`);
    // The lease matches the STALE case's 90_000 so this body differs from that
    // one ONLY in the holder's aliveness: age never decides live-vs-stale
    // (`refuse` probes the pid), and the two fixtures should show it.
    writeFileSync(lock, lockBody(holder, 90_000, "feedface"), { flag: "wx" });

    reset();
    // The refusing invocation is wrapped so the OWNED holder dies even when the
    // invocation throws: a leaked `sleep 30` keeps the fixture's lock live past
    // this case and reads as a mystery holder to anything that inspects the
    // tmpdir afterwards.
    let code: number;
    try {
      code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);
    } finally {
      alive.kill("SIGKILL");
      await alive.exited;
    }

    // 5 ("refused before provisioning"), NOT 1. Exit 1 is `exitStatus:
    // "transient"` — "retry me" — and the STALE case below proves why that is
    // wrong: nothing will ever clear a dead holder's lock, so automation
    // retries forever. The refusal is thrown between the record probe and any
    // mutation, which is exactly what 5 means.
    expect(code).toBe(5);
    expect(text()).toContain("run-locked");
    // fleet's holder wording: `acquireRunLock`'s default is the bare
    // "invocation", and the CLI passes "fleet invocation" so the refusal names
    // WHICH tool holds the run — `sandbox-teardown` takes the same lock.
    expect(text()).toContain("another fleet invocation holds");
    expect(text()).toContain(`pid ${holder}`);
    // …and the LIVE remediation, which is the only field that differs from the
    // stale branch's: gutting `isAlive()` to a constant `false` keeps the code,
    // the message and the pid identical here and sends the operator to `rm` the
    // lock of a teardown that is still destroying the run.
    const live = JSON.parse(errCaptured.find((l) => l.includes("run-locked")) as string) as {
      message: string;
      remediation: string;
    };
    expect(live.remediation).toContain("wait for that invocation to finish");
    expect(live.remediation).not.toContain("stale lock");
    expect(live.remediation).not.toContain("no live process holds it");
    // The probe answered "alive": the dead branch appends " is not running".
    expect(live.message).not.toContain("is not running");
    expect(live.message).not.toContain("liveness unknown from here");
    // The refused invocation neither tore down nor stole the holder's lock.
    expect(readFileSync(lock, "utf8")).toContain("feedface");
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await driver.list()).map((vm) => vm.name)).toContain(vmName);
    rmSync(lock);
  });

  test("a STALE lock refuses with the same non-retryable code as a live holder", async () => {
    // The case that makes exit 1 indefensible for a lock refusal: the holder is
    // gone, so NOTHING will ever release this lock — `refuse()` knows it (the
    // remediation prints the `rm` that clears it). Exit 1 is stamped
    // `transient`, so automation reading `exitStatus` retried a lock that can
    // only ever answer `run-locked`, forever.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    // A pid above every platform's pid_max, so `kill(pid, 0)` is ESRCH and the
    // lock reads stale. The body carries THIS host's token: a host `refuse`
    // cannot match is foreign, and a foreign lock is never probed and never
    // marked stale — so a body without it makes this a foreign-host test
    // wearing a stale-lock title, and every assertion below holds whatever
    // `isAlive` answers.
    const lock = join(runsDir, `${runId}.lock`);
    writeFileSync(lock, lockBody(9_999_999, 90_000, "deadbeef"), { flag: "wx" });

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);

    expect(code).toBe(5);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("run-locked")) as string) as {
      code: string;
      message: string;
      remediation: string;
    };
    expect(envelope.code).toBe("run-locked");
    // `message` is IDENTICAL on the live and the stale branch — only
    // `remediation` differs — so asserting the code and the message is
    // satisfied by an `isAlive` gutted to always return false, which tells an
    // operator to `rm` a lock a RUNNING teardown holds. The two remediations
    // are the only thing that separates them, so both are pinned here and in
    // the live-holder case above, each excluding the other's wording.
    expect(envelope.remediation).toContain("no live process holds it");
    expect(envelope.remediation).toContain("stale lock");
    expect(envelope.remediation).toContain(`rm ${lock}`);
    expect(envelope.remediation).not.toContain("wait for that invocation to finish");
    // The probe really ran and really answered "dead": the live branch omits
    // this clause, and the foreign-host branch never reaches it at all.
    expect(envelope.message).toContain("pid 9999999 is not running");
    expect(envelope.message).not.toContain("liveness unknown from here");
    // Refused before any mutation: the holder's file is intact and the run is
    // untouched.
    expect(readFileSync(lock, "utf8")).toContain("deadbeef");
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
  });

  test("harvest takes the SAME lock: a held lock refuses it, and nothing is harvested", async () => {
    // The e2e above asserts only that no lock file remains AFTER a harvest —
    // which a harvest that never acquired one satisfies identically, and the
    // only `run-locked` case in this file was teardown's. `acquireRunLock` sits
    // ABOVE the `if (verb === "harvest")` split while every other
    // teardown-only dependency (keyApi, CostLedger) already lives in the `else`
    // arm, so "harvest is read-only, why lock it" is a one-line refactor that
    // ships green — and then `fleet harvest` runs concurrently with a teardown
    // destroying the box mid-bundle. This is the case that fails when it does.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    // A live holder this case owns, in the current 4-field body layout — see
    // the teardown case above for why neither `process.pid + 1` nor a pre-host
    // body exercises the branch this test names.
    const alive = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    const holder = alive.pid;
    const lock = join(runsDir, `${runId}.lock`);
    // 90_000 like the other live-holder fixture: age is not the liveness test,
    // the pid probe is — see the teardown case above.
    writeFileSync(lock, lockBody(holder, 90_000, "feedface"), { flag: "wx" });

    reset();
    // Same owned-holder containment as the teardown case: the kill survives a
    // throwing invocation.
    let code: number;
    try {
      code = await runCli(["harvest", "--driver", "fake", "--dir", runsDir, runId], {
        ...shared,
        // D8 still holds on the refusal path: a harvest refused at the lock must
        // not have reached for credentials on its way there either.
        keyApi: keyApiTripwire(),
      });
    } finally {
      alive.kill("SIGKILL");
      await alive.exited;
    }

    // 5, the same non-retryable refusal teardown gives — not a 0 with
    // "harvested: none", which is what a lockless harvest of this box prints.
    expect(code).toBe(5);
    expect(text()).toContain("run-locked");
    expect(text()).toContain("another fleet invocation holds");
    expect(text()).toContain(`pid ${holder}`);
    // The LIVE remediation, for the same reason teardown's case pins it: the
    // message is byte-identical on the stale branch.
    expect(text()).toContain("wait for that invocation to finish");
    expect(text()).not.toContain("stale lock");
    // Nothing on stdout at all: a refusal is a diagnostic, and `harvested:`
    // would be a claim about a bundle this invocation never fetched.
    expect(outOnly).toHaveLength(0);
    // The holder's claim is intact — a refused invocation never steals it.
    expect(readFileSync(lock, "utf8")).toContain("feedface");
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
  });

  test("a lock that vanishes between the claim and the read refuses terminally, and does not spin", async () => {
    // `acquireRunLock`'s two-attempt loop had no coverage anywhere in the repo:
    // every held lock in this file is a plain file this process wrote, so
    // `refuse()` always answers on attempt 0 and the retry path is never
    // entered. A DANGLING SYMLINK at the lock path is that window made
    // deterministic — `link(2)`/`O_EXCL` see the entry and answer EEXIST (so
    // `claim` returns false), while `readFileSync` follows it and answers
    // ENOENT (so `refuse` returns undefined: "the holder finished, try again").
    //
    // Two mutations die here. Making the loop `while (true)` hangs the CLI, so
    // this test never returns. Dropping `refuse`'s ENOENT → undefined branch
    // turns a benign hand-off into `holder unknown, lock body ""` plus a
    // remediation telling the operator to rm a path with nothing behind it.
    //
    // ponytail: it cannot distinguish two attempts from one — both exhaust the
    // loop against a lock that never becomes claimable. The attempt that
    // SUCCEEDS after a refusal needs the entry to disappear between two
    // synchronous fs calls in one process, which no fs primitive affords.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    const lock = join(runsDir, `${runId}.lock`);
    symlinkSync(join(dir, "no-such-lock-target"), lock);

    reset();
    // BOUNDED. The first mutation this case names — `while (true)` instead of
    // two attempts — makes the CLI spin forever against a lock that can never
    // become claimable, and an unbounded await turns that into a whole-file
    // timeout with no attribution. `run()` is in-process and cannot be killed,
    // so the race only converts the hang into a NAMED failure; that is the
    // difference between "the retry loop is unbounded" and "the suite died".
    const code = await within(
      "teardown against a dangling lock symlink (acquireRunLock's retry loop)",
      20_000,
      runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared),
    );

    expect(code).toBe(5);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("run-locked")) as string) as {
      code: string;
      message: string;
    };
    expect(envelope.code).toBe("run-locked");
    expect(envelope.message).toContain("the lock is being taken and released repeatedly");
    // NOT the fail-closed wording: an empty body is what a reader sees mid-write,
    // and this lock was never written by anyone.
    expect(envelope.message).not.toContain("holder unknown");
    // Refused before any mutation, and the entry at the lock path is untouched:
    // the CLI released nothing it never held.
    expect(lstatSync(lock).isSymbolicLink()).toBeTrue();
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    rmSync(lock);
    // Above the 20s `within` bound, so a hang reports its own name.
  }, 40_000);

  test("teardown HOLDS the run lock when the teardown itself fails, and says so", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    const store = shared.store as RunRecordStore;
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });

    // 6, not 1. The throw came from INSIDE the destructive sequence, so the run
    // may be half-torn-down — and `transient` invites the retry that would run
    // against it. The lock is what stops that retry, so it is kept and named.
    expect(code).toBe(6);
    expect(text()).toContain("destroy-unconfirmed");
    // Kept ON PURPOSE, and this is the assertion that used to say the opposite:
    // releasing here handed the next invocation a run whose box, key and record
    // are in a state only an operator can judge (scripts/lib/run-lock.ts's
    // `markRunLockDestructive`, and scripts/fleet.ts's `destructiveInFlight`).
    // The refusal an operator sees next is `run-locked` (exit 5) with the `rm`
    // that clears it, not a silent second teardown.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeTrue();
    expect(text()).toContain("lock-held");
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await base.list()).map((vm) => vm.name)).toContain(vmName);

    // …and the kept lock DOES what it is kept for. `releaseRunLock` refuses
    // while the lock is marked destructive and only the success path clears the
    // mark (`clearRunLockDestructive` runs after `teardownSandbox` returns), so
    // the next invocation must be REFUSED rather than handed a run that is half
    // torn down. Without this, "the lock file still exists" is a claim about a
    // file and not about the guard.
    //
    // A real second PROCESS, because in-process the second acquire answers
    // `run-lock-reentrant` — this process still holds the claim in run-lock.ts's
    // `held` map — which is a programming-error branch, not the contention an
    // operator hits. `--driver fake` is resolved for real here (no injected
    // deps), which is why the boxes dir has to be handed over in the env.
    //
    // Keyless first, like every other child this file hands a record to: if the
    // lock guard above ever regresses, this child reaches the revocation step,
    // builds a REAL `openRouterKeyApi()` against $OPENROUTER_PROVISIONING_KEY
    // and talks to the live network before the assertion below gets to fail.
    // Stripping `keyHash` turns that regression into a deterministic exit-2
    // provisioning-key refusal that touches nothing.
    const recordPath = join(runsDir, `${runId}.json`);
    const { keyHash: _dropped, ...keyless } = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, JSON.stringify(keyless), { mode: 0o600 });
    const next = Bun.spawn(
      ["bun", join(import.meta.dir, "../../scripts/fleet.ts"), "teardown", "--driver", "fake", "--dir", runsDir, runId],
      { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, QDS_FAKE_BOXES_DIR: boxesDir } },
    );
    try {
      const [nextCode, nextOut, nextErr] = await within(
        "the next teardown of a run left locked",
        30_000,
        Promise.all([next.exited, readCapped(next.stdout), readCapped(next.stderr)]),
      );
      expect(nextCode).toBe(5);
      expect(nextErr).toContain("run-locked");
      // The LIVE remediation: this process is still running and still holds it,
      // so the operator must not be told to `rm` it as stale.
      expect(nextErr).toContain("wait for that invocation to finish");
      expect(nextOut).toBe("");
    } finally {
      next.kill("SIGKILL");
      await next.exited;
    }
    // The refusal neither stole nor cleared it: only an operator can.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeTrue();
    // Above the child's own 30s bound, so a hung child names its await instead
    // of being cut off here.
  }, 60_000);

  test("teardown of a run with a box, an OPEN record and no keyHash exits 6, not 0", async () => {
    // The record `dispatch` leaves if it dies between `driver.create()`
    // returning and the mint's `store.set({keyHash})` (src/fleet/dispatch.ts) —
    // a box that existed, an open run, and no surviving pointer to a key that
    // may still be billing. Absence of `keyHash` is NOT proof no key exists, so
    // the box teardown succeeds and the key cannot be revoked: `torn down:` plus
    // exit 0 is exactly what `fleet teardown … || alert` reads as "nothing left
    // running", which is the one thing that is not true here.
    //
    // Reachable this way ONLY, which is why it has to be constructed: a
    // setup-gate refusal runs after the mint, so its record carries a keyHash;
    // a budget refusal fires before `create`, so its record has no `vmName` and
    // this arm is never entered.
    const shared = deps(validBriefJson(dir));
    const base = shared.driver as FakeDriver;
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };
    // Written through the file: `store.set` skips `undefined`, so there is no
    // other way to DROP the field rather than blank it.
    const recordPath = join(runsDir, `${runId}.json`);
    const { keyHash: dropped, ...keyless } = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(dropped).toBeString(); // the field really was there to drop
    writeFileSync(recordPath, JSON.stringify(keyless), { mode: 0o600 });

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);
    expect(code).toBe(6);
    // The verb's own work LANDED — that is why 6 and not 1: retrying would send
    // automation back to tear down a run that no longer exists, and the leftover
    // is a live credential no retry of this verb can reach.
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);
    expect((await base.list()).map((vm) => vm.name)).not.toContain(vmName);
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeDefined();
    // …and the reason exit 0 would be a lie is NAMED, with the id, on stderr.
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("key-unattributable")) as string) as {
      code: string;
      runId: string;
      remediation: string;
    };
    expect(envelope.code).toBe("key-unattributable");
    expect(envelope.runId).toBe(runId);
    expect(envelope.remediation).toContain("revoke it by hand");
    // An unrevokable key is not a half-torn-down run: the lock still came off,
    // so the run stays operable.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();

    // …and the SAME id again is exit 0, which is how teardown's declared 0 stays
    // reachable at all: the record is closed now, so first-close-wins skips
    // every step and there is no key left to fail to attribute.
    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);
    expect(errCaptured.join("")).not.toContain("key-unattributable");
  });

  test("a teardown that succeeds but cannot release its lock exits 6, not 0", async () => {
    // The `finally`'s downgrade — the whole reason `code` is a mutable `let`
    // rather than an early `return 0`. Without it `fleet teardown` exits 0 on a
    // run that is now permanently un-teardownable: the lock outlives the
    // invocation, so every later harvest/teardown of that id refuses forever.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    const lock = join(runsDir, `${runId}.lock`);

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], {
      ...shared,
      // The teardown itself must SUCCEED — the release is what fails. Rewriting
      // the lock body after the destroy is the cheapest true failure:
      // releaseRunLock proves the body is still its own claim before unlinking,
      // and a foreign body is exactly the one it must refuse to delete.
      driver: driverWith(base, {
        destroy: async (vm: string) => {
          await base.destroy(vm);
          writeFileSync(lock, "99999 someone-else 2026-01-01T00:00:00.000Z deadbeef\n");
        },
      }),
    });

    expect(code).toBe(6);
    // The work DID happen — 6 says "done, but cleanup is wedged", which is why
    // it is not 1: exit 1 is `exitStatus: "transient"`, and retrying a wedged
    // lock only re-hits `run-locked` forever.
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);
    expect((await base.list()).map((vm) => vm.name)).not.toContain(runId);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("lock-release-failed")) as string) as {
      code: string;
      remediation: string;
    };
    expect(envelope.code).toBe("lock-release-failed");
    // The remediation is the operator's only way out, so it must name the exact rm.
    expect(envelope.remediation).toContain(`rm ${lock}`);
    // 6 is declared for the verb, so `fleet --help` tells the operator what it means.
    expect(listVerbs().find((v) => v.verb === "teardown")?.exitCodes).toContain(6);
    // The lock really is still on disk: that wedge IS what the exit code reports.
    expect(existsSync(lock)).toBeTrue();
  });

  test("four REAL acquirers hammer one lock and never overlap inside it", async () => {
    // Every other "held lock" in this file is a file the test wrote before
    // invoking the CLI, so `claim` is only ever asked about a path that was
    // already occupied when it started. Replacing its atomic `linkSync` /
    // O_EXCL with `existsSync(lock) ? false : writeFileSync(lock, body)` passes
    // ALL of them — and lets two concurrent teardowns both acquire, then
    // double-destroy the box and double-write the spend, which is the one thing
    // this lock exists to prevent.
    //
    // Four real processes, 60 acquire/release rounds each, checking mutual
    // exclusion from INSIDE the critical section. Counting the winners of one
    // simultaneous round is not enough: process start jitter serializes them,
    // and the check-then-act claim above passes that version of this test
    // (measured, not assumed). Overlap is the property, so overlap is what is
    // detected — and a `releaseRunLock` that finds a stranger's body is the
    // same overlap seen from the other end.
    const child = lockChild(dir);
    const runId = "qds-20260101-abcdef";
    mkdirSync(runsDir, { recursive: true });
    const startAt = Date.now() + 800; // enough for four `bun` cold starts
    const racers = Array.from({ length: 4 }, () =>
      Bun.spawn(["bun", child, runsDir, runId, "race", String(startAt)], { stdout: "pipe", stderr: "pipe" }),
    );
    try {
      const results = await within(
        "the four-way lock race",
        60_000,
        Promise.all(
          racers.map(async (p) => ({
            out: (await readCapped(p.stdout)).trim(),
            // Carried into the assertion below rather than discarded: a racer
            // that DIES is itself a mutual-exclusion symptom (a release that
            // found a stranger's body throws), and without its stderr the
            // failure reads as an empty string with no cause.
            err: (await readCapped(p.stderr)).trim().split("\n").slice(-3).join(" | "),
          })),
        ),
      );
      const parsed = results.map(({ out: r, err }) => {
        const m = /^acquired (\d+) violations (\d+)$/.exec(r);
        expect({ said: r, err, parsed: m !== null }).toEqual({ said: r, err, parsed: true });
        return { acquired: Number((m as RegExpExecArray)[1]), violations: Number((m as RegExpExecArray)[2]) };
      });
      expect(parsed.map((p) => p.violations)).toEqual([0, 0, 0, 0]);
      // …and the lock was genuinely contended rather than trivially free: every
      // racer got in at least once, so a `claim` that simply never succeeded
      // cannot pass this by making the critical section unreachable.
      for (const p of parsed) expect(p.acquired).toBeGreaterThan(0);
    } finally {
      for (const p of racers) p.kill("SIGKILL");
      await Promise.all(racers.map((p) => p.exited));
      rmSync(join(runsDir, `${runId}.lock`), { force: true });
    }
    // Four `bun` cold starts plus 240 contended rounds: past bun's 5s default,
    // and above the race's own 60s bound so a hung racer reports ITS name
    // rather than being cut off by this timeout.
  }, 90_000);

  test("on a filesystem with no hard links the O_EXCL fallback is still exclusive", async () => {
    // `claim`'s `writeLockDirect` fallback has no coverage at all, and on FUSE
    // and overlay mounts, exFAT and SMB shares and several macOS Docker
    // bind-mount configs it is not a fallback — it is THE acquire path, because
    // `link(2)` answers EPERM there every time. If it ever loses its `wx` it
    // silently overwrites a live holder's lock, and every one of those
    // deployments gets the double teardown with the whole suite green.
    const child = lockChild(dir);
    const preload = linkPreload(dir);
    const runId = "qds-20260101-abcdef";
    const lock = join(runsDir, `${runId}.lock`);
    mkdirSync(runsDir, { recursive: true });
    // Return type INFERRED, not annotated `Bun.Subprocess`: the literal
    // `stdout: "pipe"` below is what narrows the stream types, and a widening
    // annotation loses it.
    const spawnFallbackAcquirer = (linkErrno: string, mode: "hold" | "probe") =>
      Bun.spawn(["bun", "--preload", preload, child, runsDir, runId, mode], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, LINK_FAILS_AS: linkErrno },
      });

    const holder = spawnFallbackAcquirer("EPERM", "hold");
    try {
      await within("the no-hard-link holder's acquire", 20_000, awaitPath(lock));
      // The fallback wrote a COMPLETE body, not just an exclusive create: the
      // O_EXCL-then-write path re-opens the window where a reader sees "" and
      // `refuse` renders it as a lock nothing will ever clear.
      const body = readFileSync(lock, "utf8");
      expect(body.trim().split(/\s+/)).toHaveLength(4);
      expect(body.startsWith(`${holder.pid} ${LOCK_HOST} `)).toBeTrue();

      // A second acquirer on the same no-hard-link filesystem must be REFUSED,
      // not silently overwrite the live holder above.
      const loser = spawnFallbackAcquirer("EPERM", "probe");
      const said = (await within("the second no-hard-link acquire", 20_000, readCapped(loser.stdout))).trim();
      await loser.exited;
      expect(said).toBe("lost run-locked");
      expect(readFileSync(lock, "utf8")).toBe(body);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
      rmSync(lock, { force: true });
    }

    // …and the fallback is reached ONLY for the enumerated no-hard-link errnos.
    // An EIO from `link(2)` is a failure `openSync(lock, "wx")` will hit too,
    // and falling back on it reports "already claimed" against the lock we just
    // created — the same permanent wedge from the other side.
    const io = spawnFallbackAcquirer("EIO", "probe");
    const said = (await within("the EIO acquire", 20_000, readCapped(io.stdout))).trim();
    await io.exited;
    // The ERRNO, not merely "not won". `not.toBe("won")` was satisfied by a
    // child that died for any reason at all — a syntax error in the preload, a
    // missing runs directory, an OOM — so the one thing this half asserts (that
    // `claim` re-THREW the EIO instead of falling back on it) was not asserted.
    // The sibling EPERM case above already pins its exact string.
    expect(said).toBe("lost EIO");
    expect(existsSync(lock)).toBeFalse();
    // Three `within`s of 20s each: the outer budget clears the SUM, so the
    // first hung acquire names itself instead of dying to this timeout.
  }, 90_000);

  test("a signal releases a lock taken before the destructive phase, and the process dies by signal", async () => {
    // `installSignalRelease` is entirely uncovered: the only signal anywhere in
    // this file is a SIGKILL, which is uncatchable and cannot reach a handler.
    // Delete the whole function and every test still passes — while one Ctrl-C
    // during a teardown leaves `<runId>.lock` on disk forever, and this module
    // never steals, so every later harvest and teardown of that run refuses
    // while the box and the key keep billing.
    const child = lockChild(dir);
    const runId = "qds-20260101-abcdef";
    const lock = join(runsDir, `${runId}.lock`);
    mkdirSync(runsDir, { recursive: true });

    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      const holder = Bun.spawn(["bun", child, runsDir, runId, "hold"], { stdout: "pipe", stderr: "pipe" });
      await within(`the ${sig} holder's acquire`, 20_000, awaitPath(lock));
      holder.kill(sig);
      await within(`the ${sig} holder's exit`, 20_000, holder.exited);
      // The lock is GONE — the whole point of the handler.
      expect({ sig, lock: existsSync(lock) }).toEqual({ sig, lock: false });
      // …and it died BY THE SIGNAL: the handler re-raises after clearing every
      // listener rather than calling `process.exit(128+n)`, so a shell sees a
      // death by signal and `signalCode` is set. `process.exit` looks the same
      // to `$?` and is what callers reading `signalCode` cannot see.
      expect({ sig, signalCode: holder.signalCode }).toEqual({ sig, signalCode: sig });
      expect(holder.exitCode).toBeNull();
    }

    // Past `markRunLockDestructive` the handler does the OPPOSITE, deliberately:
    // the box is being destroyed and the record is half-written, and an
    // automatic release hands that state to the next teardown. The lock stays,
    // and stderr says why — so an "always release" simplification fails here.
    const destructive = Bun.spawn(["bun", child, runsDir, runId, "destructive"], { stdout: "pipe", stderr: "pipe" });
    await within("the destructive holder's acquire", 20_000, awaitPath(lock));
    destructive.kill("SIGINT");
    const [, stderr] = await within(
      "the destructive holder's exit",
      20_000,
      Promise.all([destructive.exited, readCapped(destructive.stderr)]),
    );
    expect(existsSync(lock)).toBeTrue();
    expect(stderr).toContain("lock-held:");
    expect(stderr).toContain(lock);
    // The operator is told what to inspect BEFORE clearing it — an unqualified
    // `rm` here is the double teardown.
    expect(stderr).toContain("check the run's box, key and record");
    expect(destructive.signalCode).toBe("SIGINT");
    rmSync(lock, { force: true });
    // Six `within`s of 20s each (two per signal × two signals, then the
    // destructive pair): the outer budget clears that SUM so a hung holder
    // reports which await wedged instead of being cut off here.
  }, 150_000);

  test("dispatch's SIGINT/SIGTERM handlers are DELIVERED: envelope, CC-9 line, exit 130/143", async () => {
    // The listener-count test further down cannot tell "installed and removed"
    // from "never installed" — deleting scripts/fleet.ts's interruptHandlers
    // block leaves it green. Delivery needs a REAL process holding the
    // handlers: a child running the CLI with stdin held open (no --brief),
    // which parks it inside readCappedStdin AFTER the handlers are installed
    // at the top of the verb and before anything can provision.
    //
    // The post-provisioning arm ("a box may have been provisioned") is not
    // reachable this way — it needs a driver seam held mid-flight INSIDE the
    // real process, and no black-box argv can stall dispatch between create()
    // and its ack. Everything the two arms share is pinned here: installation,
    // delivery, the stderr envelope, the CC-9 line emitted BEFORE process.exit
    // skips run()'s finallys, and the 128+n statuses outside the 0-6 table.
    const fleetPath = join(import.meta.dir, "../../scripts/fleet.ts");
    // Readiness marker via --preload (the linkPreload pattern): fleet.ts prints
    // NOTHING before it blocks on stdin, so the parent otherwise cannot tell
    // "handlers installed" from "bun still loading". The patch fires the moment
    // the FIRST SIGINT/SIGTERM listener lands — in this child that IS the
    // dispatch handler — so a signal sent after the marker cannot race the
    // install.
    const preload = join(dir, "signals-ready-preload.ts");
    writeFileSync(
      preload,
      `const realOn = process.on.bind(process);
let announced = false;
process.on = ((sig, listener) => {
  const ret = realOn(sig, listener);
  if (!announced && (sig === "SIGINT" || sig === "SIGTERM")) {
    announced = true;
    process.stdout.write("signals-ready\\n");
  }
  return ret;
});
`,
    );
    // Credential-stripped env, like the cap-boundary case: this child is the
    // REAL CLI, so if a regression ever carried it past the brief read we want
    // a deterministic provisioning-key refusal, never a network mint.
    const { OPENROUTER_PROVISIONING_KEY: _provKey, ...signalChildEnv } = process.env;

    for (const [sig, status] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
    ] as const) {
      const proc = Bun.spawn(["bun", "--preload", preload, fleetPath, "dispatch", "--driver", "fake"], {
        cwd: dir,
        env: signalChildEnv,
        stdin: "pipe", // held open: readCappedStdin waits forever for a chunk that never comes
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // The marker read CONSUMES its bytes (a stream does not replay them),
        // so stdout is asserted as before + after around this split.
        const beforeReady = await within(
          `the ${sig} dispatch child's readiness`,
          30_000,
          readUntilMarker(proc.stdout, "signals-ready"),
        );
        proc.kill(sig);
        const [code, stdout, stderr] = await within(
          `the ${sig} interrupted dispatch`,
          30_000,
          Promise.all([proc.exited, readCapped(proc.stdout), readCapped(proc.stderr)]),
        );
        // 128+signo, deliberately outside the 0-6 table — and a CLEAN exit
        // code, because the handler called process.exit; the default
        // disposition would report death by signal instead.
        expect({ sig, code }).toEqual({ sig, code: status });
        // Nothing printed before readiness, the marker at readiness, and no ack
        // afterwards — an interrupted-before-provisioning dispatch outputs
        // nothing but the preload's marker.
        expect({ sig, stdout: beforeReady + stdout }).toEqual({ sig, stdout: "signals-ready\n" });
        const lines = stderr
          .trimEnd()
          .split("\n")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        const envelopeAt = lines.findIndex((l) => l.code === "dispatch-interrupted");
        expect({ sig, found: envelopeAt >= 0 }).toEqual({ sig, found: true });
        const envelope = lines[envelopeAt] as Record<string, unknown>;
        // The pre-provisioning branch VERBATIM: claiming a possible box for an
        // invocation interrupted before it could make one sends an operator
        // auditing the provider console for a box that does not exist.
        expect(envelope.message).toBe("interrupted before dispatch began provisioning: nothing was created");
        expect(envelope.remediation).toContain("no box, key or record exists for this invocation");
        // CC-9 BEFORE the exit: process.exit skips run()'s finallys and its
        // `return finish(...)`, so the line must be emitted from the handler
        // itself — an interrupted dispatch was the one invocation a dashboard
        // could not see at all. Ordered against the envelope, not merely present.
        const done = lines.findIndex((l) => l.phase === "complete");
        expect(done).toBeGreaterThan(envelopeAt);
        const line = lines[done] as Record<string, unknown>;
        expect(line.operation).toBe("fleet.dispatch");
        expect(line.exitCode).toBe(status);
        // 130/143 are neither 0 nor 1: classified with the operator errors,
        // never with the retryable substrate.
        expect(line.exitStatus).toBe("logic");
        // …and truly nothing was created: no runs dir under the redirected
        // default ($QDS_RUNS_DIR points into this case's tmpdir).
        expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
      }
    }
    // Two children × (readiness + exit), each bounded at 30s: the outer budget
    // clears that SUM so the first hung child names its await.
  }, 120_000);

  test("fleet and sandbox-teardown exclude each other through the SAME per-run lock", async () => {
    // The file header claims both CLIs take one shared lock, and nothing showed
    // it: the two only ever ran sequentially here, asserting `cost_events` and
    // never the lock. Give `sandbox-teardown` its own lock path — a one-line
    // change, and the most natural refactor when either CLI grows a second runs
    // directory — and `fleet teardown <id>` runs concurrently with
    // `sandbox-teardown <id>`, destroying the same box twice.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    // Keyless, so `sandbox-teardown` never reaches for a provisioning key on
    // the success path below (it takes no deps seam).
    const recordPath = join(runsDir, `${runId}.json`);
    const { keyHash: _dropped, ...keyless } = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    writeFileSync(recordPath, JSON.stringify(keyless), { mode: 0o600 });

    // A THIRD process holds the lock through the real `acquireRunLock`, so this
    // is the file both CLIs actually compete for and not a fixture shaped like
    // one. In-process the second acquire would answer `run-lock-reentrant`,
    // which is a different branch entirely.
    const lock = join(runsDir, `${runId}.lock`);
    const holder = Bun.spawn(["bun", lockChild(dir), runsDir, runId, "hold"], { stdout: "pipe", stderr: "pipe" });
    try {
      await within("the cross-CLI holder's acquire", 20_000, awaitPath(lock));

      reset();
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(5);
      expect(text()).toContain("another fleet invocation holds");
      expect(text()).toContain(`pid ${holder.pid}`);

      reset();
      // DF2.5's own CLI, refused by the SAME file — and its table is 0/1 only,
      // so a lock refusal is 1 there where fleet can afford its own 5.
      expect(await sandboxTeardownRun([runId, "--dir", runsDir, "--driver", "fake"], out)).toBe(1);
      expect(text()).toContain("run-locked");
      expect(text()).toContain("another sandbox-teardown holds");
      expect(text()).toContain(lock);
      expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();
    } finally {
      // SIGTERM, not SIGKILL: the holder's own signal handler releases the lock
      // on the way out, which is what makes the success below a statement about
      // the LOCK rather than about a file this test deleted.
      holder.kill("SIGTERM");
      await holder.exited;
    }

    // The holder is gone and its lock went with it, so the refusals above were
    // the lock and nothing else: the same invocation now succeeds.
    expect(existsSync(lock)).toBeFalse();
    reset();
    expect(await sandboxTeardownRun([runId, "--dir", runsDir, "--driver", "fake"], out)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
  }, 30_000);

  // ─── --dir moves the whole .sandbox set, ledger included ───────────────────

  test("--dir scopes the cost ledger to the records dir, never the ambient cwd", async () => {
    // No chdir anywhere in this case — that IS the property. Both halves of the
    // run's money must land beside the records the operator named: the ledger
    // read from the cwd meant a run reserved its budget in one file at dispatch
    // and settled its box hours in another at teardown.
    const sandbox = join(dir, "sbx");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    // The box-hour rate lives ONLY here. The repo cwd has no cost-config.json,
    // so a cwd-resolved config falls back to the built-in defaults, which carry
    // no rate — and the teardown's box-hours ingest would refuse rather than
    // price at 0. The exit 0 below is what proves the config followed --dir too.
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    // The manifest lives in the case's own tmpdir, resolved against an INJECTED
    // containment root. It used to be a committed repo path with `repoRoot`
    // deliberately omitted, which made this the one case whose INV-1 resolution
    // ran against `process.cwd()`: any test in the run that chdir'd turned it
    // into `manifest-rejected` exit 2, and the only guard was a bare toBe(0).
    // `repoRoot` is not the subject here — the money is — so the dependency is
    // removed rather than documented.
    const brief = validBriefJson(dir);
    const shared: Partial<FleetDeps> = {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      readBrief: async () => brief,
      repoRoot: dir,
      // store and ledgerFactory are deliberately NOT injected: --dir has to
      // build both, and injecting either would hide the thing under test.
    };
    // A SENTINEL at the ambient path, not a `existsSync(...) ? mtime : null`
    // read of it: that form compared `null` to `null` on any machine without a
    // pre-existing ledger — i.e. on every clean checkout and in CI, exactly
    // where the regression is supposed to be caught. The ambient path is where
    // `$QDS_RUNS_DIR`'s parent puts it (beforeEach redirects that into this
    // case's tmpdir), so an implementation that ignored --dir would open THIS
    // file, and opening it as a SQLite db is a write.
    const ambientLedger = join(dir, ".sandbox", "cost-ledger.db");
    const sentinel = "not-a-sqlite-file — the --dir ledger must never be this one\n";
    writeFileSync(ambientLedger, sentinel);

    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runs], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    // INSIDE the records dir, not beside it: the ledger is the shared, written
    // state, so it moves with the records `--dir` named. (`cost-config.json`
    // stays a sibling — it is the operator's hand-written file, and moving it
    // made every non-default `--dir` fail teardown as `box-hour-rate-unconfigured`.)
    expect(existsSync(join(runs, "cost-ledger.db"))).toBeTrue();
    expect(existsSync(join(runs, `${runId}.json`))).toBeTrue();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
    // Box hours priced into the --dir ledger, and the ambient one untouched —
    // byte for byte, and with no -wal/-shm beside it, which is what a SQLite
    // handle opened on it would have left.
    expect(existsSync(join(runs, "cost-ledger.db"))).toBeTrue();
    expect(readFileSync(ambientLedger, "utf8")).toBe(sentinel);
    expect(readdirSync(join(dir, ".sandbox")).filter((f) => f.startsWith("cost-ledger.db"))).toEqual([
      "cost-ledger.db",
    ]);
  });

  test("sandbox-teardown settles into the SAME ledger fleet dispatch reserved from", async () => {
    // The two CLIs share a run: `fleet dispatch --dir X` reserves budget and
    // `sandbox-teardown --dir X` settles the box hours. sandbox-teardown built
    // its CostLedger with NO path at all, so it fell back to the cwd-relative
    // `.sandbox/cost-ledger.db` while the reservation sat beside X — and that
    // reservation then stays open forever, counting against the budget cap, in
    // a file nothing settles. Both now resolve through
    // scripts/lib/cost-ledger-opts.ts.
    const sandbox = join(dir, "shared-money");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    // Box hours are only priced when the CONFIG resolves beside the records
    // too, so this file is also the proof the second half of the pair followed.
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    // Manifest in the case's tmpdir against an injected `repoRoot` (see the
    // --dir case above): a committed repo path here resolved INV-1 against
    // `process.cwd()`, so any chdir elsewhere in the run turned this money
    // regression test into a `manifest-rejected` exit 2 behind a bare toBe(0).
    const brief = validBriefJson(dir);
    // NEITHER driver nor store nor ledger injected: both CLIs must resolve the
    // fake boxes (via $QDS_FAKE_BOXES_DIR) and the money from --dir themselves,
    // which is the whole subject.
    const ambientLedger = join(dir, ".sandbox", "cost-ledger.db");
    const sentinel = "not-a-sqlite-file — neither CLI may settle into this one\n";
    writeFileSync(ambientLedger, sentinel);

    expect(
      await runCli(["dispatch", "--driver", "fake", "--dir", runs], {
        keyApi: new FakeKeyApi(),
        readBrief: async () => brief,
        repoRoot: dir,
      }),
    ).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    // Inside the records dir — see the --dir case above.
    const ledgerPath = join(runs, "cost-ledger.db");
    expect(existsSync(ledgerPath)).toBeTrue();

    // Make the run KEYLESS before the second CLI touches it. `sandboxTeardownRun`
    // takes no deps seam, so a record carrying a `keyHash` makes it build a real
    // `openRouterKeyApi()` — which reads $OPENROUTER_PROVISIONING_KEY and, when
    // one is present, revokes over the network. That is a second silent ambient
    // dependency behind this case's bare `toBe(0)`: with the repo's own `.env`
    // loaded it passed, and from any other cwd the same money assertions failed
    // as `provisioning-key-missing`. The credential path is not what this case
    // is about — where the box hours LAND is — so it is removed rather than
    // depended on. Written through the file because `set()` skips `undefined`
    // and there is no other way to drop the field.
    const recordPath = join(runs, `${runId}.json`);
    const { keyHash: _dropped, ...keyless } = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    expect(_dropped).toBeString(); // the field really was there to drop
    writeFileSync(recordPath, JSON.stringify(keyless), { mode: 0o600 });

    reset();
    // DF2.5's own CLI, not fleet's teardown verb — the one that was settling
    // somewhere else.
    expect(await sandboxTeardownRun([runId, "--dir", runs, "--driver", "fake"], out)).toBe(0);
    expect(outOnly.join("")).toContain(`torn down: ${runId}`);

    // The box hours are IN the --dir ledger, under this run…
    const db = new Database(ledgerPath, { readonly: true });
    try {
      const rows = db.query("SELECT kind FROM cost_events WHERE run_id = ?").all(runId) as { kind: string }[];
      expect(rows.map((r) => r.kind)).toContain("box_hours");
    } finally {
      db.close();
    }
    // …and the cwd-relative default was never opened: byte-identical, with no
    // -wal/-shm beside it, which a SQLite handle on it would have left.
    expect(readFileSync(ambientLedger, "utf8")).toBe(sentinel);
    expect(readdirSync(join(dir, ".sandbox")).filter((f) => f.startsWith("cost-ledger.db"))).toEqual([
      "cost-ledger.db",
    ]);
  });

  test("a second teardown of the same run exits 0 and bills its box hours exactly once", async () => {
    // `teardownSandbox` short-circuits a CLOSED record (first-close-wins) and
    // re-runs the box-hours ingest, so `fleet teardown <id>` on an
    // already-torn-down run skips every step, prints `torn down: <id>` and
    // exits 0 — telling an operator it just destroyed a box that has been gone
    // for hours. No case invoked teardown twice on one id, so nothing pinned
    // either half of that: not the exit code, and not the claim that makes it
    // defensible. The ingest re-run is DF2.8's crash-window fix (close landed,
    // the process died before the row did), and it is idempotent by event id —
    // without that idempotence a re-run bills the same hours again, against the
    // budget cap, and only a REAL ledger can show it. So no `ledgerFactory` and
    // no `store` here: both are the CLI's own, beside the records.
    const sandbox = join(dir, "twice");
    const runs = join(sandbox, "runs");
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(join(sandbox, "cost-config.json"), '{"boxHourRateMicroUsd": 3600000}');
    const brief = validBriefJson(dir);
    const shared: Partial<FleetDeps> = {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      readBrief: async () => brief,
      repoRoot: dir,
    };

    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runs], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    const store = new RunRecordStore(runs);
    const closedAt = store.get(runId).closedAt as string;
    expect(closedAt).toBeDefined();

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runs, runId], shared)).toBe(0);
    // NOT `toContain("torn down: <id>")`. That line is what the comment above
    // condemns — it claims a destroy that did not happen, for a box that has
    // been gone since the first pass — and pinning it makes an implementation
    // that finally distinguishes the idempotent re-run FAIL here. A test that
    // holds a defect in place is worse than no test, so what is asserted is the
    // property that must hold whatever wording the source settles on: the
    // second pass is a NO-OP. (The misleading message itself is reported as an
    // open source defect, not ratcheted in here.)
    expect(errCaptured).toHaveLength(0);
    // first-close-wins: the record still reports the FIRST teardown's instant,
    // so the second pass re-closed nothing.
    expect(store.get(runId).closedAt).toBe(closedAt);
    // …and the money was settled once, not twice.
    const db = new Database(join(runs, "cost-ledger.db"), { readonly: true });
    try {
      const rows = db.query("SELECT event_id FROM cost_events WHERE run_id = ? AND kind = 'box_hours'").all(runId);
      expect(rows).toHaveLength(1);
    } finally {
      db.close();
    }
    // The second invocation took the lock like any other and gave it back.
    expect(existsSync(join(runs, `${runId}.lock`))).toBeFalse();
  });

  test("--dir reaches the status verb too, not just dispatch and teardown", async () => {
    // Every other status case injects `deps.store`, so the CLI never resolved
    // --dir for this verb: `fleet status --dir /elsewhere` could regress to
    // listing the default runs dir and report "no runs" for a live fleet.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake", "--dir", runsDir], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    // Driver injected (the fake boxes live in this case's tmpdir); store NOT —
    // that is the thing under test.
    const { store: _omitted, ...noStore } = shared;
    reset();
    expect(await runCli(["status", "--driver", "fake", "--dir", runsDir], noStore)).toBe(0);
    expect(JSON.parse(outOnly[0] as string)).toMatchObject({ runId, state: "live" });

    // …and pointed elsewhere the SAME box has no record to claim it, so it
    // reports as unattributed spend. A --dir the status verb silently ignored
    // would still find the record and call it `live`.
    reset();
    // Created first: the read verbs refuse a `--dir` that is not there rather
    // than mkdir'ing it (scripts/fleet.ts `assertRecordsDirUsable`), so an
    // EMPTY records directory — not an absent one — is what "the same box with
    // no record to claim it" looks like.
    mkdirSync(join(dir, "other-runs"), { recursive: true, mode: 0o700 });
    expect(await runCli(["status", "--driver", "fake", "--dir", join(dir, "other-runs")], noStore)).toBe(0);
    const orphan = JSON.parse(outOnly[0] as string) as { runId: string; state: string; vmName: string };
    // FakeDriver names the box after the run, so vmName and runId coincide here —
    // but the label is asserted off the row's OWN vmName, the discipline the
    // orphan case above pins (`(orphan <vmName>)`: there is no record, so the
    // BOX is the only true name for it), rather than off the id they happen to
    // share on this driver.
    expect(orphan.vmName).toBe(runId);
    expect(orphan).toMatchObject({ runId: `(orphan ${orphan.vmName})`, state: "orphan" });
  });

  test("a completed teardown whose result line hits a CLOSED PIPE exits 6 via completion-unwritable (round 10)", async () => {
    // BEHAVIOR CHANGE (review round 10, FC1): this used to expect exit 0. `fleet
    // teardown <id> | head -1` closes the pipe around the time `torn down:`
    // prints, and the EPIPE was swallowed silently by plain `emit` — while the
    // SAME line lost to ENOSPC or a bad fd reported 6 through
    // `completion-unwritable`, and the dispatch ack lost to EPIPE reported 6
    // through `ack-unwritable`. Three write failures, three postures; now one:
    // a completion line describes work that already happened, so however its
    // write failed, the caller hears "landed but unreportable" (6), never a
    // silent success.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    reset();
    const closedPipe = (): never => {
      const e = new Error("write EPIPE") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, runId], closedPipe, shared, errOut);

    expect(code).toBe(6);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("completion-unwritable")) as string) as {
      code: string;
      message: string;
    };
    expect(envelope.code).toBe("completion-unwritable");
    // The work really happened behind the lost line — which is why 6 ("done,
    // needs an operator") and not 1 ("retry me") is the honest report.
    expect((await base.list()).map((vm) => vm.name)).not.toContain(vmName);
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeDefined();
    // And the lock still came off: the finally runs on this path too.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
  });

  test("status still exits 0 when stdout is a closed pipe", async () => {
    // The other verb an operator pipes: `fleet status | head -1` closes the pipe
    // after the first row, and every later row's write throws EPIPE. Reported as
    // the verb's outcome it makes a read-only query indistinguishable from a
    // substrate failure — the exit code `status` reserves for "the provider
    // could not be listed", which is the one thing that did NOT happen here.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);

    reset();
    const closedPipe = (): never => {
      const e = new Error("write EPIPE") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    expect(await run(["status", "--driver", "fake"], closedPipe, shared, errOut)).toBe(0);
    // A broken pipe is not a listing failure, so nothing is claimed on the
    // diagnostics sink either.
    expect(errCaptured).toHaveLength(0);
  });

  test("a verb that SUCCEEDED but could not print all of its output exits 6", async () => {
    // EPIPE and EAGAIN part company here, and only EPIPE was covered. A hung-up
    // reader is reading nothing more either way, so EPIPE is silent (exit 0
    // above). EAGAIN is an fd 1 a wrapper or CI runner left non-blocking, still
    // open, still being read — and `writeAll` advances across a PARTIAL write
    // before it throws, so `fleet status` over a fleet big enough to fill the
    // pipe buffer ended mid-token on a half-written `{"runId":"…`. Exit 0 said
    // that truncated listing WAS the fleet: the same lie `listUnavailable` → 1
    // exists to prevent, and a `| jq` consumer gets a parse error or, worse, a
    // short listing it believes.
    const shared = deps(validBriefJson(dir));
    // TWO runs, so the "one line per invocation, not per refused write" rule has
    // something to be wrong about.
    for (let i = 0; i < 2; i++) expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);

    reset();
    let refused = 0;
    const nonBlocking = (): never => {
      refused++;
      const e = new Error("fd 1 accepted 0 of 64 bytes") as NodeJS.ErrnoException;
      e.code = "EAGAIN";
      throw e;
    };
    const code = await run(["status", "--driver", "fake", "--dir", runsDir], nonBlocking, shared, errOut);

    // 6, not 0 and not 1. The verb's work is done — it is a read — so a retry
    // cannot undo or redo it; only the printing failed, and what WAS printed
    // must not be parsed.
    expect(code).toBe(6);
    // Every row really was refused, so this is the truncation case and not a
    // single unlucky write.
    expect(refused).toBeGreaterThan(1);
    const truncation = errCaptured.filter((l) => l.includes("stdout-truncated"));
    // ONE line, not one per refused write: a full pipe refuses every row after
    // the first, and the diagnostic must not itself flood the operator's stderr.
    expect(truncation).toHaveLength(1);
    const envelope = JSON.parse(truncation[0] as string) as { code: string; message: string; remediation: string };
    expect(envelope.code).toBe("stdout-truncated");
    expect(envelope.message).toContain("INCOMPLETE");
    expect(envelope.remediation).toContain("do not parse what was printed");
  });

  test("a NON-ERROR write failure (throw null) still reports ack-unwritable, not a TypeError (CodeRabbit round 8)", async () => {
    // A sink may reject with null/undefined (a bare `throw;`, a violated
    // library contract). The catch that reports it must not become its own
    // failure: `(e as Error).message` on null throws a TypeError inside the
    // handler, escaping as a retryable-looking exit 1 over a box that is
    // live and billing. Same shape as the ENOSPC sibling, minus the Error.
    const shared = deps(validBriefJson(dir));
    const nullSink = (): never => {
      throw null;
    };
    const code = await run(["dispatch", "--driver", "fake"], nullSink, shared, errOut);
    expect(code).toBe(6);
    const line = errCaptured.find((l) => l.includes("ack-unwritable"));
    expect(line).toBeDefined();
    const envelope = JSON.parse(line as string) as { code: string; runId: string };
    expect(envelope.code).toBe("ack-unwritable");
    expect(envelope.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
  });

  test("a write failure that is NOT a broken pipe is still a failure", async () => {
    // The other half of the EPIPE tolerance: ENOSPC means the output was lost
    // to a full disk with a reader still there, and swallowing that would make
    // every unwritten ack a silent success.
    const shared = deps(validBriefJson(dir));
    const enospc = (): never => {
      const e = new Error("write ENOSPC") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    const code = await run(["dispatch", "--driver", "fake"], enospc, shared, errOut);
    // 6, not 1. A lost dispatch ack means a box was provisioned and its run id
    // never reached the caller: exit 1 is `exitStatus: "transient"` = "retry
    // me", and retrying dispatch provisions a SECOND box while the first keeps
    // billing with nothing pointing at it. 6 is "the work happened, the
    // bookkeeping is wedged, a human must look".
    expect(code).toBe(6);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("ack-unwritable")) as string) as {
      code: string;
      runId: string;
      remediation: string;
    };
    expect(envelope.code).toBe("ack-unwritable");
    // The envelope is the operator's ONLY copy of the run id now — the ack that
    // carried it is the write that failed — so it must name the id and the
    // exact command that reclaims the box, both keyed to the run that is
    // actually billing.
    expect(envelope.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(envelope.remediation).toContain(`fleet teardown ${envelope.runId}`);
    // Box identity pinned to vmName — the driver's own name for the billing box
    // — like every sibling case, not to the id. `vmName === runId` is a
    // FakeDriver naming convention, not the envelope's promise; asserting it
    // made a driver-side rename fail this test while leaving the actual claim
    // (a live box exists for the named run) untested.
    const record = (shared.store as RunRecordStore).get(envelope.runId);
    // A dispatched run's record always names its box; `?? ""` only keeps the
    // optional field honest — an unnamed record cannot match any real VM.
    expect((await (shared.driver as FakeDriver).list()).map((vm) => vm.name)).toContain(record.vmName ?? "");
    expect(errCaptured.join("")).toContain("ENOSPC");
  });

  test("a teardown that completed but could not print its result line exits 6, not 1", async () => {
    // `torn down:` describes work that has ALREADY happened — a destroyed box,
    // a closed record. A bare emit tolerates EPIPE (above) and EAGAIN (above),
    // but any other write failure (ENOSPC, a bad fd) threw out of the verb's
    // try into `report`, which stamped landed destructive work exit 1 =
    // `transient` — automation re-running a teardown that had already landed.
    // The dispatch ack's posture, applied: one diagnostic, exit 6.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    reset();
    const enospc = (): never => {
      const e = new Error("write ENOSPC") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, runId], enospc, shared, errOut);

    // 6, not 0 and not 1: the verb landed, so a retry cannot undo it, and only
    // the printing failed.
    expect(code).toBe(6);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("completion-unwritable")) as string) as {
      code: string;
      message: string;
      remediation: string;
    };
    expect(envelope.code).toBe("completion-unwritable");
    expect(envelope.message).toContain("completed");
    expect(envelope.remediation).toContain("fleet status");
    // The work really happened behind the lost line — that is why 1 was so wrong.
    expect((await base.list()).map((vm) => vm.name)).not.toContain(vmName);
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeDefined();
    // …and the lock still came off, so the run stays operable.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
  });

  test("a harvest that completed but could not print its result line exits 6, not 1", async () => {
    // The harvest half of the same posture: `harvested:` is the ONLY report of
    // a capture that already ran, so its write failure is "landed but
    // unreportable" (6), never a retryable 1.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const enospc = (): never => {
      const e = new Error("write ENOSPC") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    };
    const code = await run(["harvest", "--driver", "fake", "--dir", runsDir, runId], enospc, shared, errOut);

    expect(code).toBe(6);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("completion-unwritable")) as string) as {
      code: string;
      message: string;
    };
    expect(envelope.code).toBe("completion-unwritable");
    // Harvest is credential-free and read-side: the lock came off and nothing
    // was left half-done for a retry to trip over.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
  });

  test("a teardown that fails BEFORE completing still reports its own failure, not 6", async () => {
    // The boundary the landed-work guards above must not blur: 6 is for work
    // that HAPPENED and could not be reported. A verb that never got there —
    // here the record probe refuses on a corrupt record body — keeps its own
    // exit 1, because a retry CAN succeed once the operator fixes the record.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };
    writeFileSync(join(runsDir, `${runId}.json`), "{not json", { mode: 0o600 });

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared);

    expect(code).toBe(1);
    expect(text()).toContain("malformed run record");
    // Nothing landed: the box is still live and the corrupt body is still on
    // disk, unread (re-reading it here would throw on the very corruption the
    // fixture planted — the raw bytes are the evidence instead).
    expect((await base.list()).map((vm) => vm.name)).toContain(vmName);
    expect(readFileSync(join(runsDir, `${runId}.json`), "utf8")).toBe("{not json");
  });

  test("a repeated boolean flag is refused, exactly as a repeated value flag is", async () => {
    // `bools` is a Set, so `--no-harvest --no-harvest` silently collapsed —
    // and --no-harvest is the flag that WAIVES artifact capture, so a doubled
    // one is precisely the invocation an operator must be sure they typed.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(
      ["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", "--no-harvest", runId],
      shared,
    );
    expect(code).toBe(2);
    expect(text()).toContain("--no-harvest given more than once");
    // Refused as a usage error: nothing was torn down.
    expect((shared.store as RunRecordStore).get(runId).closedAt).toBeUndefined();

    // Aliases count as the same flag (round 10): `-h --help` names one flag
    // twice, but the raw-string dup scan saw two distinct tokens and waved the
    // pair through to `bools`, whose Set collapsed it — the guard existed for
    // exactly this invocation and missed it. Canonicalized BEFORE the count,
    // so the refusal names the canonical flag.
    reset();
    const aliasCode = await runCli(["status", "-h", "--help"], deps(""));
    expect(aliasCode).toBe(2);
    expect(text()).toContain("--help given more than once");
  });

  test("a --dir that does not exist is exit 2 on every READ verb, and is not created", async () => {
    // `new RunRecordStore` mkdirs recursively and chmods 0700, which is right
    // for `dispatch` — the verb that creates runs — and wrong for the three that
    // only look. `fleet teardown qds-nosuchrun --dir /srv/typo` exited 4 having
    // CREATED /srv/typo and every missing parent, so the operator's next `fleet
    // status --dir /srv/typo` reported a clean empty fleet from a directory that
    // exists only because they typo'd it once, while the real fleet billed on.
    //
    // 2, not 4: 4 is "that RUN does not exist", which presumes a records
    // directory to have looked in. This is the invocation being wrong, and it is
    // wrong identically on every retry.
    const typo = join(dir, "srv", "typo");
    for (const argv of [
      ["status", "--driver", "fake", "--dir", typo],
      ["status", "--driver", "fake", "--dir", typo, "qds-20260101-abcdef"],
      ["harvest", "--driver", "fake", "--dir", typo, "qds-20260101-abcdef"],
      ["teardown", "--driver", "fake", "--dir", typo, "qds-20260101-abcdef"],
    ]) {
      reset();
      // `store` deliberately NOT injected — an injected store is already built,
      // so there is nothing left for this guard to refuse.
      const code = await runCli(argv, { driver: new FakeDriver(boxesDir) });
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(`--dir ${typo} does not exist`);
      expect(text()).toContain("ENOENT");
      // Neither the directory nor its missing parent: the refusal mutated nothing.
      expect({ argv, made: existsSync(typo) || existsSync(join(dir, "srv")) }).toEqual({ argv, made: false });
    }
    // The DEFAULT directory is unaffected — creating `.sandbox/runs` on first
    // use is the intended bootstrap, and refusing it breaks every fresh checkout.
    reset();
    expect(await runCli(["status", "--driver", "fake"], { driver: new FakeDriver(boxesDir) })).toBe(0);
  });

  test("`fleet status --dir <existing>` reads it without re-permissioning it to 0700", async () => {
    // `status` builds its store with `{create: false}`, which skips the mkdir AND
    // the chmod. With a writable store, looking at an operator's records
    // directory silently changed its mode — a read-only query mutating the one
    // thing it was pointed at. harvest/teardown deliberately still use a
    // writable store (`teardownSandbox` calls `store.close`/`set`), so this is
    // about `status` alone.
    const loose = join(dir, "loose-runs");
    mkdirSync(loose, { recursive: true });
    chmodSync(loose, 0o755); // mkdir's mode is masked by the umask; chmod is not
    expect(statSync(loose).mode & 0o777).toBe(0o755);

    reset();
    expect(await runCli(["status", "--driver", "fake", "--dir", loose], { driver: new FakeDriver(boxesDir) })).toBe(0);
    expect(errCaptured).toHaveLength(0);
    expect(statSync(loose).mode & 0o777).toBe(0o755);
  });

  test("a --dir that cannot BE a records dir exits 2, not a retryable 1", async () => {
    // `new RunRecordStore` throws bare Errors (ENOTDIR here) with no `code`, so
    // it fell through `report`'s generic branch as exit 1 = `transient`:
    // automation retried a `--dir` pointing at a regular file forever.
    const notADir = join(dir, "definitely-a-file");
    writeFileSync(notADir, "not a directory\n");
    const code = await runCli(["status", "--driver", "fake", "--dir", notADir], {
      driver: new FakeDriver(boxesDir),
    });
    expect(code).toBe(2);
    // The store's own message survives the reclassification.
    expect(errCaptured.join("")).toContain(notADir);
  });

  test("a --dir the store cannot even create exits 2 as well, whatever the errno", async () => {
    // The ENOTDIR case above is one of THREE bare-Error shapes `new
    // RunRecordStore` throws, and they share one classification (`asUsage`) —
    // so this pins the second reachable one, from a different call site: the
    // `mkdirSync` rather than the mode check. `--dir` at a self-referential
    // symlink is ELOOP, deterministic and permission-free.
    //
    // The mode branch (`… is mode 0755, not 0700`) is NOT reachable from a
    // test: the constructor chmods the directory to 0700 itself and only then
    // verifies, so a loose directory is repaired rather than refused, and the
    // throw needs a filesystem or an owner where that chmod cannot stick.
    const loop = join(dir, "self-link");
    symlinkSync(loop, loop);
    const code = await runCli(["status", "--driver", "fake", "--dir", loop], {
      driver: new FakeDriver(boxesDir),
    });
    expect(code).toBe(2);
    // The store's own message survives the reclassification here too.
    expect(errCaptured.join("")).toContain(loop);
  });

  test("an invalid brief names the FIELD even on a host with no provisioning key", async () => {
    // AC1. `openRouterKeyApi()` reads $OPENROUTER_PROVISIONING_KEY at
    // construction, and building it before dispatch validated meant a
    // malformed brief exited 2 with `provisioning-key-missing` and no field —
    // the operator set the env var and re-hit the very same brief.
    // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
    delete process.env.OPENROUTER_PROVISIONING_KEY;
    const code = await runCli(["dispatch", "--driver", "fake"], {
      driver: new FakeDriver(boxesDir),
      store: new RunRecordStore(runsDir),
      ledgerFactory: () => goodLedger(),
      readBrief: async () => '{"repoSlug":"nope"}',
      repoRoot: dir,
    });
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; field?: string; issues?: string[] };
    expect(envelope.code).toBe("invalid-brief");
    // The FIELD, exactly. `toBeString()` is satisfied by `""`, by `"unknown"`
    // and by the wrong field name — in the one test whose entire subject is
    // that the operator is told WHICH field to fix.
    expect(envelope.field).toBe("repoSlug");
    // …and the field is the first of the issues, not the only one: a brief
    // this broken has five, and an operator who fixes only `repoSlug` and
    // re-runs must not discover the other four one round-trip at a time.
    expect(envelope.issues).toEqual([
      "repoSlug: Invalid",
      "issueId: Required",
      "commitSha: Required",
      "manifestPath: Required",
      "repoUrl: Required",
    ]);
    expect(errCaptured.join("")).not.toContain("provisioning-key-missing");
    // INV-2 either way: an invalid brief provisions nothing.
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("status exits non-zero and says so when the provider cannot be listed", async () => {
    // With zero open records a total listing failure used to be an exit 0 and
    // a clean stdout — byte-identical to a healthy empty fleet, while every box
    // in it kept billing. `statusAll` now emits a `listUnavailable` row; the
    // CLI must not print it and call the invocation a success.
    const base = new FakeDriver(boxesDir);
    const code = await runCli(["status", "--driver", "fake"], {
      ...deps(validBriefJson(dir)),
      driver: driverWith(base, {
        list: async () => {
          throw new Error("substrate unreachable");
        },
      }),
    });
    expect(code).toBe(1); // the substrate failed — retrying IS the right move
    expect(JSON.parse(outOnly[0] as string)).toMatchObject({ state: "listUnavailable" });
    // …and the reason is on the diagnostics sink, where `fleet status | jq`
    // does not have to parse around it.
    expect(errCaptured.join("")).toContain("list-unavailable");
  });

  test("…and it exits 1 on a listing failure when every record is CLOSED too", async () => {
    // The zero-records case above is one half of the hole. This is the other:
    // `boxUnknown` only ever attaches to an OPEN record, so with every record
    // closed a total listing failure produced rows that all read as settled and
    // an exit 0 — and a closed record whose destroy never landed is precisely
    // the box that is still billing behind it.
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);

    reset();
    const code = await runCli(["status", "--driver", "fake"], {
      ...shared,
      driver: driverWith(base, {
        list: async () => {
          throw new Error("substrate unreachable");
        },
      }),
    });

    expect(code).toBe(1);
    const rows = outOnly.map((l) => JSON.parse(l) as { runId: string; state: string; boxAlive?: boolean });
    expect(rows.map((r) => r.state)).toContain("listUnavailable");
    const closed = rows.find((r) => r.runId === runId) as { state: string; boxAlive?: boolean };
    expect(closed.state).toBe("closed");
    // ABSENT, not `false`: the substrate never answered, so "the box is gone" is
    // not a thing this row is entitled to claim.
    expect(closed.boxAlive).toBeUndefined();
    expect(errCaptured.join("")).toContain("list-unavailable");
  });

  test("status exits 2 and says so when a record file could not be read at all", async () => {
    // The record-side half of `listUnavailable`, and the same argument: a
    // listing that REFUSED a record file is not the fleet, and exit 0 says it
    // is. `reapRuns` already treats the identical condition as a hard refusal.
    // Nothing covered it through the CLI, so the rows printed fine and the
    // invocation reported a clean fleet with a file it never opened in it.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    // A `.json` whose stem is not a run id: the store cannot key it, so it is
    // skipped rather than parsed. (A dispatch happened first so there is a GOOD
    // row too — "some rows are missing" is the claim, not "nothing was read".)
    writeFileSync(join(runsDir, "NOT-A-RUN-ID.json"), "{}\n");

    reset();
    const code = await runCli(["status", "--driver", "fake", "--dir", runsDir], shared);

    // 2, not 1. Exit 1 is `exitStatus: "transient"` = "retry me", and a
    // malformed record filename is there on every retry — the same reasoning
    // the teardown `finally` uses for exit 6.
    expect(code).toBe(2);
    const rows = outOnly.map((l) => JSON.parse(l) as { runId: string; state: string; skippedRecords?: string[] });
    // The good row is still printed: the rows are worth having, they are just
    // not the whole fleet.
    expect(rows.map((r) => r.runId)).toContain(runId);
    expect(rows.flatMap((r) => r.skippedRecords ?? [])).toEqual(["NOT-A-RUN-ID.json"]);
    // …and the reason is a diagnostic, on the sink `fleet status | jq` does not
    // have to parse around, naming the file so an operator can act on it.
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("records-skipped")) as string) as {
      code: string;
      message: string;
      skippedRecords: string[];
    };
    expect(envelope.code).toBe("records-skipped");
    expect(envelope.message).toContain("are not the whole fleet");
    expect(envelope.skippedRecords).toEqual(["NOT-A-RUN-ID.json"]);
  });

  test("a skipped-record FILENAME reaches the operator sanitized — a newline cannot forge a status line", async () => {
    // `readdirSync` hands back whatever the filesystem holds, and POSIX names
    // may carry newlines: `"bad\nFLEET teardown ok.json"` interpolated raw into
    // a row or the records-skipped envelope forges an operator-facing line.
    // The row is the producer, so both the stdout row AND the stderr envelope
    // must carry the repaired name.
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    writeFileSync(join(runsDir, "bad\nFLEET teardown ok.json"), "{}\n");

    reset();
    const code = await runCli(["status", "--driver", "fake", "--dir", runsDir], shared);

    // Still exit 2 — sanitization changes the NAME, never the verdict.
    expect(code).toBe(2);
    const rows = outOnly.map((l) => JSON.parse(l) as { skippedRecords?: string[] });
    expect(rows.flatMap((r) => r.skippedRecords ?? [])).toEqual(["badFLEET teardown ok.json"]);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("records-skipped")) as string) as {
      skippedRecords: string[];
    };
    expect(envelope.skippedRecords).toEqual(["badFLEET teardown ok.json"]);
    // The raw form appears NOWHERE in either stream.
    expect(text()).not.toContain("bad\nFLEET");
  });

  test("a record-supplied createdAt is sanitized like every other row field", async () => {
    // A real store proves only that `Date.parse` accepts createdAt; the store
    // is a structural interface, so a hostile one can hand back a parseable
    // string with a forged log line glued to it and `rowForRecord` passed it
    // through raw while its sibling fields were sanitized.
    const shared = deps(validBriefJson(dir));
    const hostileRec = {
      runId: "qds-20260101-aaaaaa",
      createdAt: "2026-01-01T00:00:00.000Z\nFLEET teardown ok",
    };
    const hostileStore = {
      dir: runsDir,
      listWithAnomalies: () => ({ records: [hostileRec], skipped: [] }),
      get: () => hostileRec,
    } as unknown as RunRecordStore;

    reset();
    const code = await runCli(["status", "--driver", "fake"], { ...shared, store: hostileStore });

    expect(code).toBe(0);
    const row = JSON.parse(outOnly[0] as string) as { runId: string; state: string; createdAt?: string };
    expect(row.state).toBe("boxMissing"); // no box answers to the id; the verb still ran clean
    expect(row.createdAt).toBe("2026-01-01T00:00:00.000ZFLEET teardown ok");
    // Every emitted row line ends in a newline by design; the forged SECOND
    // line is what must not exist.
    expect(text()).not.toContain("\nFLEET teardown ok");
  });

  test("a listing whose RECORDS are not objects refuses typed, not as a TypeError", async () => {
    // One step deeper than the shape guard's `{records, skipped}` check: the
    // store is a structural interface, so a store answering `{records: [null]}`
    // satisfies the type while `rowForRecord` dereferences `null.vmName`. That
    // TypeError used to leave statusAll untyped; now it lands in the same
    // record-store-unreadable refusal any other unreadable listing gets — and
    // is REFUSED rather than dropped, because a silently missing record is
    // exactly the truncated fleet the recordsSkipped row exists to keep honest.
    const shared = deps(validBriefJson(dir));
    const brokenStore = {
      dir: runsDir,
      listWithAnomalies: () => ({ records: [null, undefined, 7], skipped: [] }),
    } as unknown as RunRecordStore;

    reset();
    const code = await runCli(["status", "--driver", "fake"], { ...shared, store: brokenStore });

    expect(code).toBe(1);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("record-store-unreadable")) as string) as {
      code: string;
      message: string;
      remediation: string;
    };
    expect(envelope.code).toBe("record-store-unreadable");
    expect(envelope.remediation).toContain("fleet status");
    // No rows were printed off the broken listing.
    expect(outOnly).toHaveLength(0);
  });

  test("a store error whose DIAGNOSTIC ITSELF throws still refuses record-store-unreadable", async () => {
    // safeDiagnostic's contract is that ANY thrown value classifies. A value
    // whose `.message` getter throws used to escape the helper mid-catch and
    // replace the typed refusal with a secondary crash — the one failure mode
    // the helper exists to make impossible.
    const shared = deps(validBriefJson(dir));
    const hostileDiagnosticStore = {
      dir: runsDir,
      listWithAnomalies: (): { records: unknown[]; skipped: unknown[] } => {
        throw Object.create(null, {
          message: {
            get(): string {
              throw new Error("message getter boom");
            },
          },
        });
      },
    } as unknown as RunRecordStore;

    reset();
    const code = await runCli(["status", "--driver", "fake"], { ...shared, store: hostileDiagnosticStore });

    expect(code).toBe(1);
    const envelope = JSON.parse(errCaptured.find((l) => l.includes("record-store-unreadable")) as string) as {
      code: string;
      message: string;
    };
    expect(envelope.code).toBe("record-store-unreadable");
    expect(envelope.message).toContain("[unprintable diagnostic]");
    expect(outOnly).toHaveLength(0);
  });

  test("no minted key material reaches stdout, stderr or the CC-9 log line", async () => {
    // INV-2 is enforced on the RECORD, and commit 78c9bd7 took a key out of the
    // CLI's own log fields — with nothing left behind to keep it out. The three
    // sinks a `fleet` invocation writes are an operator's terminal, their shell
    // history's redirect and their log aggregator, and a key printed to any of
    // them outlives the run it was minted for. `plaintexts` is the fake's
    // test-side record of exactly what was minted, so this scans for the real
    // secret rather than for a pattern that resembles one.
    const keyApi = new FakeKeyApi({ usageOnCreateUsd: 0.25 });
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), keyApi };
    const entries: LogEntry[] = [];
    const restore = setLogSink((e) => {
      entries.push(e);
    });
    try {
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
      expect(await runCli(["status", "--driver", "fake"], shared)).toBe(0);
      // Teardown too: it is the verb that READS the key back to revoke it.
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);
    } finally {
      restore();
    }

    const minted = [...keyApi.plaintexts.values()];
    // The tripwire is only a tripwire if a key was actually minted.
    expect(minted).not.toHaveLength(0);
    const sinks = [outOnly.join(""), errCaptured.join(""), JSON.stringify(entries)];
    for (const secret of minted) {
      expect(secret.length).toBeGreaterThan(MIN_REDACTABLE_LEN);
      // `leakScan`, not `not.toContain(secret)`. The whole-string form catches
      // only a VERBATIM, unescaped copy — so a key logged with its issuer prefix
      // trimmed, split across two fields, JSON-escaped, or truncated to "the
      // first 40 chars for debugging" walked straight through the one assertion
      // that exists to stop it. The repo already owns the right scanner: it
      // sweeps every MIN_REDACTABLE_LEN-char fragment (the redactor's own
      // boundary constant, so it tracks the redaction rule instead of
      // re-hard-coding 8 here) and carries the key-management deep-link rule
      // with it. The three sinks stay SEPARATE strings so nothing can leak
      // across a join.
      const leaked = leakScan(secret, ...sinks);
      expect({ head: `${secret.slice(0, 4)}…`, leaked }).toEqual({ head: `${secret.slice(0, 4)}…`, leaked: null });
    }
  });

  test("run() leaves the process's signal handlers exactly as it found them", async () => {
    // Two module-latched leaks meet here. `installSignalRelease` registers four
    // signal handlers plus an `exit` handler in a process it does not own —
    // this test runner's — and de-latching it (or moving the install into the
    // acquire loop) grows that set on every teardown until Node warns and then
    // truncates, silently dropping the release handler the lock depends on.
    // Dispatch's own SIGINT/SIGTERM pair is scoped to the verb and removed in
    // its `finally` precisely because `run()` is an embeddable function; drop
    // the removal and every embedder accumulates a handler per call that exits
    // the whole process on the next Ctrl-C.
    const shared = deps(validBriefJson(dir));
    // Warm both latches first — run-lock's one-time install is not a leak.
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const first = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, first.runId], shared)).toBe(0);

    const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "exit"] as const;
    const counts = (): Record<string, number> =>
      Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]));
    const before = counts();

    for (let i = 0; i < 3; i++) {
      reset();
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], shared)).toBe(0);
    }

    expect(counts()).toEqual(before);
    // r7: eight sequential in-process CLI round-trips routinely exceed bun's
    // 5s default under load; the timeout must never be what fails a listener
    // arithmetic test (a timeout here also wedges the lock for the NEXT test,
    // turning one flake into two).
  }, 20_000);

  test("observingMint reports the minted id at create() time and forwards everything else (round 10)", async () => {
    // FC10's seam, pinned directly. dispatch() persists via store.create long
    // before its promise resolves, but the CLI used to learn the run id only
    // from the RESOLVED ack — so a SIGINT in between logged the interrupt line
    // with `runId: null` for a record already on disk. Wrapping the store makes
    // the persist itself the notification; no seam was added to dispatch.ts.
    const minted: string[] = [];
    const base = new RunRecordStore(runsDir);
    const observed = observingMint(base, (id) => minted.push(id));
    const rec = observed.create("qds-20260101-abcdef");
    expect(minted).toEqual(["qds-20260101-abcdef"]);
    // Forwarded intact: the record really landed through the wrapper…
    expect(rec.runId).toBe("qds-20260101-abcdef");
    expect(base.get("qds-20260101-abcdef").createdAt).toBeDefined();
    // …and every non-create member still answers through it.
    expect(observed.get("qds-20260101-abcdef").runId).toBe("qds-20260101-abcdef");
    observed.set("qds-20260101-abcdef", { vmName: "vm-through-proxy" });
    expect(observed.get("qds-20260101-abcdef").vmName).toBe("vm-through-proxy");
    expect(observed.dir).toBe(runsDir);
    rmSync(join(runsDir, "qds-20260101-abcdef.json"), { force: true });
  });

  test("a throw that is not an Error still reports exit 1 with a message", async () => {
    // report()'s `x.code ?? "error"` / `x.message ?? String(e)` normalisation.
    // A rejected string has no `.message`, and a printer that assumed one turned
    // a failure into `undefined` — or threw while reporting it.
    const code = await runCli(["dispatch", "--driver", "fake"], {
      ...deps(validBriefJson(dir)),
      readBrief: () => Promise.reject("substrate said no"),
    });
    expect(code).toBe(1);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; stack?: string };
    expect(envelope.code).toBe("error");
    expect(envelope.message).toBe("substrate said no");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("dispatch whose ack cannot be written exits 6 with the box LIVE and the run id named", async () => {
    // `fleet dispatch … | head -0`: the pipe closes before the ack line lands,
    // `out()` throws EPIPE, and the run id — the ONLY handle on a box that is
    // live and billing, and on the key just minted for it — is gone. Nothing
    // reached this arm before, so `dispatch` could not declare 6 in the verb
    // registry without the ⊇ check in verbs.test.ts calling it unreachable.
    //
    // Not 1: `logVerb` stamps 1 `transient` ("retry me"), and retrying dispatch
    // provisions a SECOND box rather than recovering the first.
    const shared = deps(validBriefJson(dir));
    const driver = shared.driver as FakeDriver;
    const brokenStdout = (): never => {
      // Coded: see the help-table probe above — the ack must NOT ride the
      // EPIPE-tolerant `emit`, and a coded throw is what makes that branchable.
      const e = new Error("EPIPE: broken pipe, write") as NodeJS.ErrnoException;
      e.code = "EPIPE";
      throw e;
    };
    const code = await run(["dispatch", "--driver", "fake"], brokenStdout, shared, errOut);
    expect(code).toBe(6);

    const envelope = errCaptured
      .map((l) => JSON.parse(l) as { code: string; message: string; remediation?: string; runId?: string })
      .find((e) => e.code === "ack-unwritable");
    expect(envelope).toBeDefined();
    // The run id is what makes the refusal actionable — an operator who cannot
    // read it off stdout has to find the box by hand before it stops billing.
    const runId = envelope!.runId as string;
    expect(runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(envelope!.remediation).toContain(`fleet teardown ${runId}`);
    // The premise: the box really is LIVE. An exit 6 over a box that was never
    // provisioned would be a different (and much less urgent) failure.
    expect((await driver.list()).map((vm) => vm.name)).toContain(runId);
  });

  test("dispatch at an interactive terminal refuses instead of waiting forever", async () => {
    // The one guard `deps.readBrief` hides: injecting the reader replaces the
    // isTTY check with it. Without the guard `fleet dispatch` typed by hand
    // blocks on a pipe that never arrives — no error, no timeout, no log line.
    const own = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      const code = await runCli(["dispatch", "--driver", "fake"], {});
      expect(code).toBe(2);
      expect(text()).toContain("no brief on stdin");
      expect(text()).toContain("--brief");
    } finally {
      if (own === undefined) Reflect.deleteProperty(process.stdin, "isTTY");
      else Object.defineProperty(process.stdin, "isTTY", own);
    }
  });

  // ─── THE E2E DEMO (DoD, mandatory): dispatch → status → teardown ──────────

  test("e2e: dispatch → status → teardown against the fake driver", async () => {
    const brief = validBriefJson(dir);
    // ONE shared fleet across all three verbs: the teardown verb's
    // captureSpend reads the key dispatch minted, so the FakeKeyApi and store
    // must be the same instances (a fresh keyApi sees no such key and the
    // spend stays unwritten). The key starts with $0.25 of simulated in-box
    // usage so the captured spend is a NUMBER worth asserting.
    const driver = new FakeDriver(boxesDir);
    const keyApi = new FakeKeyApi({ usageOnCreateUsd: 0.25 });
    const store = new RunRecordStore(runsDir);
    // Held, not created per call, so `closeCalls` is readable below: the real
    // ledger owns a SQLite handle and dispatch must close it on every path.
    const ledger: RecordingLedger = goodLedger();
    const shared: Partial<FleetDeps> = {
      driver,
      keyApi,
      store,
      ledgerFactory: () => ledger,
      readBrief: async () => brief,
      repoRoot: dir,
    };

    // 1. dispatch — prints the ack, exits 0
    const dispatchCode = await runCli(["dispatch", "--driver", "fake"], shared);
    expect(dispatchCode).toBe(0);
    const ackLine = captured.find((l) => l.startsWith("{") && l.includes("runId")) as string;
    expect(ackLine).toBeDefined();
    const ack = JSON.parse(ackLine) as {
      runId: string;
      requestId: string;
      state: string;
      vmName: string;
      httpsUrl?: string;
    };
    expect(ack.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    expect(ack.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(ack.state).toBe("ready");
    expect(ack.vmName).toBe(ack.runId);
    expect((await driver.list()).map((vm) => vm.name)).toContain(ack.vmName);
    // The ack is OUTPUT: stdout, and nothing on the diagnostics sink at all.
    // `import.meta.main` binds that sink to fd 2 so `fleet dispatch | jq` reads
    // clean JSON, and every other case in this file used to merge the two.
    expect(outOnly).toContain(ackLine);
    expect(errCaptured).toHaveLength(0);
    // The ack and NOTHING else. `toContain(ackLine)` is satisfied by a stdout
    // that also carries a progress line, a stray `console.log` or a diagnostic
    // that leaked across — and `fleet dispatch | jq` reads the whole stream, so
    // a second line is a parse error rather than an extra one it can skip. The
    // `status` cases below already hold themselves to this (`outOnly[0]`, and
    // parse-every-line); dispatch's own output never was.
    expect(outOnly).toHaveLength(1);
    expect(JSON.parse(outOnly[0] as string)).toEqual(ack);
    // One admission, one close: the handle the ledger owns does not leak per run.
    expect(ledger.admitCalls).toHaveLength(1);
    expect(ledger.closeCalls).toBe(1);

    // 2. status — lists the run live
    reset();
    const statusCode = await runCli(["status", "--driver", "fake"], shared);
    expect(statusCode).toBe(0);
    expect(errCaptured).toHaveLength(0);
    const rowLine = outOnly.find((l) => l.includes(ack.runId)) as string;
    expect(rowLine).toBeDefined();
    const row = JSON.parse(rowLine) as { runId: string; state: string };
    expect(row.runId).toBe(ack.runId);
    expect(row.state).toBe("live");

    // 3. teardown — destroys the box and closes the record with the spend
    reset();
    const teardownCode = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, ack.runId], shared);
    expect(teardownCode).toBe(0);
    expect(text()).toContain(`torn down: ${ack.runId}`);
    const record = store.get(ack.runId);
    expect(record.closedAt).toBeDefined();
    // The key's $0.25 of usage, captured BEFORE the revoke (INV-4) — `typeof
    // === "number"` was satisfied by NaN, 0 and -1 alike.
    expect(record.spendMicroUsd).toBe(250_000);
    // A teardown that closes the record but never calls driver.destroy leaks
    // the VM forever, and every assertion above still passes.
    expect((await driver.list()).map((vm) => vm.name)).not.toContain(ack.vmName);
    // The lock it took is released, so the run stays operable.
    expect(existsSync(join(runsDir, `${ack.runId}.lock`))).toBeFalse();

    // 4. post-teardown status reports closed
    reset();
    const afterCode = await runCli(["status", "--driver", "fake", ack.runId], shared);
    expect(afterCode).toBe(0);
    const closedRow = JSON.parse(outOnly[0] as string) as { state: string; boxAlive?: boolean };
    expect(closedRow.state).toBe("closed");
    // `false`, not absent: a successful list is EVIDENCE the box is gone, and
    // the closed row now carries it either way (absent means the substrate
    // could not be listed, i.e. no evidence — see statusAll's boxes === null).
    expect(closedRow.boxAlive).toBe(false);
  });

  test("e2e: --no-harvest prints the waiver only after the teardown succeeds", async () => {
    const shared = deps(validBriefJson(dir));
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], shared)).toBe(0);
    const waiver = captured.findIndex((l) => l.includes("teardown.harvest_waived"));
    const done = captured.findIndex((l) => l.includes(`torn down: ${runId}`));
    expect(waiver).toBeGreaterThanOrEqual(0);
    // Printed first, the waiver claims a waiver for a teardown that may never
    // have happened.
    expect(waiver).toBeLessThan(done);
  
  });

  test("a failed teardown prints no harvest waiver at all", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    reset();
    const code = await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });
    // 6, for the reason the lock test above states: the failure happened inside
    // the destructive sequence, so the lock is held and no retry can clear it.
    expect(code).toBe(6);
    expect(text()).toContain("destroy-unconfirmed");
    expect(text()).not.toContain("teardown.harvest_waived");
    expect(text()).not.toContain("torn down:");

  });

  // ─── fanout + rank (DF3.2): the two new verbs at the front door ────────────

  /** Full fanout wiring over the case tmpdir — the deps() seams plus DF3.2's. */
  function fanoutDeps(): Partial<FleetDeps> {
    return {
      ...deps(validBriefJson(dir)),
      fanoutsDir: join(dir, ".sandbox", "fanouts"),
      lockPath: join(dir, ".sandbox", "fleet.lock"),
    };
  }

  test("e2e: fanout best-of-n admits its arms and prints one ack per arm plus the ranking line", async () => {
    const d = fanoutDeps();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
      d,
    );
    expect(code).toBe(0);
    interface ArmAck {
      fanoutId: string;
      arm: number;
      runId: string;
      outcome: string;
      vmName?: string;
    }
    interface RankedLine {
      scores: { arm: number; runId: string; score: number | null }[];
      tie: boolean;
      rationale: string;
    }
    const lines = outOnly.map((l) => JSON.parse(l) as unknown); /* dp:ok test-authored output: stdout this test's own CLI run just emitted */
    // One ack line PER ARM, then best-of-n's auto-rank summary.
    expect(lines).toHaveLength(3);
    const [armA, armB, ranked] = lines as [ArmAck, ArmAck, RankedLine];
    for (const [i, arm] of [
      [0, armA],
      [1, armB],
    ] as const) {
      expect(arm?.outcome).toBe("ready");
      expect(arm?.arm).toBe(i);
      expect(arm?.runId).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
      expect(typeof arm?.vmName).toBe("string");
    }
    expect(armA?.fanoutId).toBe(armB?.fanoutId);
    // This verb has no step-output source (`--steps-json` is rank's flag), so
    // every arm is LISTED unscored with a rationale saying how to score them.
    expect(ranked?.scores.every((s) => s.score === null)).toBeTrue();
    expect(ranked?.tie).toBeFalse();
    expect(ranked?.rationale).toContain("--steps-json");
    // The run records are joined to the fan-out through the extension
    // namespace, and the fleet lock did not survive the verb.
    const store = d.store as RunRecordStore;
    for (const arm of [armA, armB]) {
      const rec = store.get(arm?.runId as string);
      expect(rec.extensions?.fanout).toEqual({
        schemaVersion: 1,
        fanoutId: arm?.fanoutId,
        arm: String(arm?.arm),
      });
    }
    expect(existsSync(join(dir, ".sandbox", "fleet.lock"))).toBeFalse();
  });

  test("e2e: many-stories takes the briefs wrapper and skips the ranking step", async () => {
    const brief = JSON.parse(validBriefJson(dir)) as Record<string, unknown>; /* dp:ok test-authored output: parses the string validBriefJson() built above */
    const d: Partial<FleetDeps> = {
      ...fanoutDeps(),
      readBrief: async () => JSON.stringify({ briefs: [brief] }),
    };
    const code = await runCli(["fanout", "--driver", "fake", "--pattern", "many-stories", "--n", "1"], d);
    expect(code).toBe(0);
    const lines = outOnly.map((l) => JSON.parse(l) as Record<string, unknown>); /* dp:ok test-authored output: stdout this test's own CLI run just emitted */
    // The degenerate case is the same code path: one ack, NO ranking line.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.outcome).toBe("ready");
    expect(outOnly.join("")).not.toContain('"scores"');
  });

  test("fanout validation refusals exit 2 naming the guard, having provisioned nothing", async () => {
    const cases: [string[], string][] = [
      // Round 3 (F-C1): the pattern-scoped structural refusals are hoisted to
      // the CLI's pre-construction block, so these rows hit usageErrors whose
      // prose mirrors fanout()'s taxonomy — pinned by message, not code.
      [["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "1", "--roster", "a"], "--n takes an integer 2-8"],
      [
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b,c"],
        "the roster count must equal --n",
      ],
      [
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b", "--pin", "d".repeat(40)],
        "pin-mismatch",
      ],
      // --roster is structurally forbidden for many-stories BEFORE the brief is
      // even ingested, so this refuses the same way with or without the
      // briefs wrapper (the wrapper guard still owns the no-roster case below).
      [["fanout", "--driver", "fake", "--pattern", "many-stories", "--n", "1", "--roster", "a"], "--roster is not valid for many-stories"],
      [["fanout", "--driver", "fake", "--pattern", "many-stories", "--n", "1"], "wrap the n brief objects"],
    ];
    for (const [argv, needle] of cases) {
      reset();
      const code = await runCli(argv, fanoutDeps());
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(needle);
      expectNoBoxes();
    }
  });

  test("fanout refuses --n 0 with exit 2 naming the 1-8 range", async () => {
    // Source rejects n < 1 with "takes an integer 1-8" (fleet.ts ~1291).
    // This test pins the --n 0 boundary case explicitly.
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "0", "--roster", "a"],
      fanoutDeps(),
    );
    expect(code).toBe(2);
    expect(text()).toContain("--n takes an integer 1-8");
    expectNoBoxes();
  });

  test("fanout refuses no-headroom with exit 5 before provisioning anything", async () => {
    const d: Partial<FleetDeps> = {
      ...fanoutDeps(),
      quotaLimits: { limits: { ...DEFAULT_QUOTA_LIMITS, maxVms: 1 }, source: "default" },
    };
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
      d,
    );
    expect(code).toBe(5);
    expect(text()).toContain("no-headroom");
    expectNoBoxes();
  });

  test("--dir is the fan-outs directory for BOTH verbs: fanout → rank round-trip", async () => {
    // One flag, one meaning (rank's): the producer drops its record under
    // --dir so `rank <id> --dir <same>` finds it. Run records stay on their
    // own default/env chain — a fan-*.json inside a runs dir would make every
    // later sweep of that dir report malformed_record_name anomalies.
    const fanouts = join(dir, "operator-fanouts");
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta", "--dir", fanouts],
      // fanoutsDir deliberately NOT injected — the flag is the subject. The
      // lock still must not land in the repo cwd.
      { ...deps(validBriefJson(dir)), lockPath: join(dir, ".sandbox", "fleet.lock") },
    );
    expect(code).toBe(0);
    const files = readdirSync(fanouts).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    const fanoutId = (
      JSON.parse(readFileSync(join(fanouts, files[0] as string), "utf8")) as { fanoutId: string } /* dp:ok test-authored output: parses the record this test's own fanout run just wrote */
    ).fanoutId;
    expect(fanoutId).toMatch(/^fan-\d{8}-[a-f0-9]{6}$/);
    // The consumer finds it through the SAME flag value.
    reset();
    expect(await runCli(["rank", fanoutId, "--dir", fanouts], deps(""))).toBe(0);
  });

  test("without --dir both verbs resolve the shared default fan-outs chain", async () => {
    // `$QDS_FANOUTS_DIR` is the middle tier of the SAME resolver both verbs
    // call with no explicit dir — redirected here only to keep the default
    // hermetic (the repo cwd has no .sandbox of its own under test).
    const prev = process.env.QDS_FANOUTS_DIR;
    process.env.QDS_FANOUTS_DIR = join(dir, "env-fanouts");
    try {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
        { ...deps(validBriefJson(dir)), lockPath: join(dir, ".sandbox", "fleet.lock") },
      );
      expect(code).toBe(0);
      const files = readdirSync(join(dir, "env-fanouts")).filter((f) => f.endsWith(".json"));
      expect(files).toHaveLength(1);
      const fanoutId = (
        JSON.parse(readFileSync(join(dir, "env-fanouts", files[0] as string), "utf8")) as { fanoutId: string } /* dp:ok test-authored output: parses the record this test's own fanout run just wrote */
      ).fanoutId;
      reset();
      expect(await runCli(["rank", fanoutId], deps(""))).toBe(0);
    } finally {
      // Reflect.deleteProperty, not `= undefined`: Bun coerces an undefined
      // assignment into the STRING "undefined", poisoning later resolvers in
      // the same process.
      if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_FANOUTS_DIR");
      else process.env.QDS_FANOUTS_DIR = prev;
    }
  });

  test("a fanout whose completion lines cannot print exits 6 with the work landed", async () => {
    const d = fanoutDeps();
    let refused = 0;
    const nonBlocking = (): never => {
      refused++;
      const e = new Error("fd 1 accepted 0 bytes") as NodeJS.ErrnoException;
      e.code = "EAGAIN";
      throw e;
    };
    const code = await run(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
      nonBlocking,
      d,
      errOut,
    );
    // 6, not 0 and not 1: both arms LANDED (boxes provisioned, records written)
    // and only the printing failed — retrying would provision a second fan-out.
    expect(code).toBe(6);
    expect(refused).toBeGreaterThan(1);
    expect(errCaptured.filter((l) => l.includes("stdout-truncated"))).toHaveLength(1);
    // The work is real even though its acks never printed: exactly one fan-out
    // record exists for it.
    expect(readdirSync(join(dir, ".sandbox", "fanouts"))).toHaveLength(1);
  });

  test("a rank with no --steps-json whose result line cannot print exits 6 with rankedAt stamped", async () => {
    const fanoutsPath = join(dir, ".sandbox", "fanouts");
    const fstore = new FanoutRecordStore({ dir: fanoutsPath });
    const id = mintFanoutId();
    fstore.create({
      fanoutId: id,
      requestId: "01234567-89ab-cdef-0123-456789abcdef",
      pattern: "best-of-n",
      n: 2,
      pin: "c".repeat(40),
      createdAt: new Date().toISOString(),
      arms: [
        { arm: 0, runId: "qds-20260101-00000c", briefHash: "a".repeat(64) },
        { arm: 1, runId: "qds-20260101-00000d", briefHash: "a".repeat(64) },
      ],
      winner: null,
      rankedAt: null,
      closedAt: new Date().toISOString(),
    });
    let refused = 0;
    const nonBlocking = (): never => {
      refused++;
      const e = new Error("fd 1 accepted 0 bytes") as NodeJS.ErrnoException;
      e.code = "EAGAIN";
      throw e;
    };
    reset();
    // No --steps-json: the ranking still LANDS (every arm listed unscored, the
    // C2 advisory posture) and its one result line is what cannot print.
    const code = await run(["rank", id, "--dir", fanoutsPath], nonBlocking, deps(""), errOut);
    // 6, not 0: the record was read, scores computed and rankedAt STAMPED —
    // re-running would refuse nothing (rank is idempotent) but a caller that
    // parsed the truncated stdout got no table at all.
    expect(code).toBe(6);
    expect(refused).toBeGreaterThanOrEqual(1);
    expect(errCaptured.filter((l) => l.includes("stdout-truncated"))).toHaveLength(1);
    // The work landed even though its line never printed.
    expect(fstore.get(id).rankedAt).not.toBeNull();
  });

  test("rank scores a completed fan-out from --steps-json and stamps rankedAt", async () => {
    const fanoutsPath = join(dir, ".sandbox", "fanouts");
    const fstore = new FanoutRecordStore({ dir: fanoutsPath });
    const id = mintFanoutId();
    fstore.create({
      fanoutId: id,
      requestId: "01234567-89ab-cdef-0123-456789abcdef",
      pattern: "best-of-n",
      n: 2,
      pin: "c".repeat(40),
      createdAt: new Date().toISOString(),
      arms: [
        { arm: 0, runId: "qds-20260101-00000a", briefHash: "a".repeat(64) },
        { arm: 1, runId: "qds-20260101-00000b", briefHash: "a".repeat(64) },
      ],
      winner: null,
      rankedAt: null,
      closedAt: new Date().toISOString(),
    });
    // Union = {a.ts, b.ts, c.ts} (3 files); each arm touches 2 ⇒ coverage 2/3.
    // Arm 1 passes everything (rate 1.0), arm 0 passes 8/10 — a 0.12 gap, past
    // the tie window.
    const stepsPath = join(dir, "steps.json");
    writeFileSync(
      stepsPath,
      JSON.stringify({
        "qds-20260101-00000a": { testsExecuted: true, testResults: { passed: 8, failed: 2 }, changedFiles: ["src/a.ts", "src/b.ts"] },
        "qds-20260101-00000b": { testsExecuted: true, testResults: { passed: 10, failed: 0 }, changedFiles: ["src/a.ts", "src/c.ts"] },
      }),
    );
    reset();
    const code = await runCli(["rank", id, "--dir", fanoutsPath, "--steps-json", stepsPath], deps(""));
    expect(code).toBe(0);
    const result = JSON.parse(outOnly[0] as string) as { /* dp:ok test-authored output: rank result line this run just emitted to outOnly */
      fanoutId: string;
      scores: { arm: number; runId: string; score: number; breakdown: Record<string, number> }[];
      tie: boolean;
      rationale: string;
    };
    expect(result.fanoutId).toBe(id);
    expect(result.scores[0]?.runId).toBe("qds-20260101-00000b"); // 1.0 pass rate wins
    expect(result.scores[0]?.score).toBeCloseTo(1 * 0.6 + (2 / 3) * 0.4, 6);
    expect(result.scores[1]?.score).toBeCloseTo(0.8 * 0.6 + (2 / 3) * 0.4, 6);
    // AC7's breakdown carries EXACTLY the two keys.
    expect(Object.keys(result.scores[0]?.breakdown ?? {}).sort()).toEqual([
      "testPassRate",
      "uniqueFileCoverage",
    ]);
    expect(result.tie).toBe(false);
    expect(fstore.get(id).rankedAt).not.toBeNull();
  });

  test("rank without --steps-json lists every arm unscored and still exits 0", async () => {
    const fanoutsPath = join(dir, ".sandbox", "fanouts");
    const fstore = new FanoutRecordStore({ dir: fanoutsPath });
    const id = mintFanoutId();
    fstore.create({
      fanoutId: id,
      requestId: "01234567-89ab-cdef-0123-456789abcdef",
      pattern: "best-of-n",
      n: 1,
      pin: "c".repeat(40),
      createdAt: new Date().toISOString(),
      arms: [{ arm: 0, runId: "qds-20260101-00000c", briefHash: "a".repeat(64) }],
      winner: null,
      rankedAt: null,
      closedAt: new Date().toISOString(),
    });
    reset();
    const code = await runCli(["rank", id, "--dir", fanoutsPath], deps(""));
    expect(code).toBe(0);
    const result = JSON.parse(outOnly[0] as string) as { /* dp:ok test-authored output: rank result line this run just emitted to outOnly */
      scores: { score: number | null }[];
      tie: boolean;
      rationale: string;
    };
    expect(result.scores).toHaveLength(1);
    expect(result.scores[0]?.score).toBeNull(); // listed, never dropped
    expect(result.tie).toBe(false);
    expect(result.rationale).toContain("no step-output source provided");
  });

  test("rank refuses an unknown fan-out id with exit 4, naming it", async () => {
    // --dir keeps this hermetic: with none, the store constructor mkdirs the
    // cwd-relative default (.sandbox/fanouts) INTO THE REPO TREE before the
    // lookup can refuse.
    reset();
    const code = await runCli(
      ["rank", "fan-19700101-ffffff", "--dir", join(dir, ".sandbox", "fanouts")],
      deps(""),
    );
    expect(code).toBe(4);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string }; /* dp:ok test-authored output: error envelope this run just emitted to errCaptured */
    expect(envelope.code).toBe("fanout-not-found");
    expect(envelope.message).toContain("fan-19700101-ffffff");
  });

  test("a malformed --steps-json refuses before the fan-outs store is constructed", async () => {
    // Negative counts are the boundary case rank() itself also refuses; here
    // the FLAG parser must name it first — and the refusal must not mkdir/chmod
    // the --dir it was about to be refused over (the id grammar's principle,
    // one step further down the verb).
    const stepsPath = join(dir, "steps.json");
    writeFileSync(
      stepsPath,
      JSON.stringify({ r0: { testsExecuted: true, testResults: { passed: -3, failed: 1 } } }),
    );
    const freshDir = join(dir, "never-created-fanouts");
    reset();
    const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { message: string }; /* dp:ok test-authored output: error envelope this run just emitted to errCaptured */
    expect(envelope.message).toContain("non-negative integer");
    expect(existsSync(freshDir)).toBeFalse();
  });

  test("each remaining --steps-json shape refusal exits 2 naming its own branch", async () => {
    // The negative-count branch above is pinned separately (rank() refuses it
    // too); these are the flag parser's OWN refusals. Each asserts its
    // distinguishing message — exit 2 alone would pass for any usage error.
    const stepsPath = join(dir, "steps.json");
    const freshDir = join(dir, "never-created-either");
    const cases: [string | null, string][] = [
      [null, "cannot read"], // never written: the read itself fails
      ['{"r0":', "not valid JSON"],
      ["[]", "keyed by run id"],
      // The envelope JSON-escapes the quoted run id, so the needle spells the escapes too.
      ['{"r0": 7}', 'entry \\"r0\\" must be an object'],
      ['{"r0": {"testsExecuted": "yes"}}', "non-boolean testsExecuted"],
      ['{"r0": {"changedFiles": "src/a.ts"}}', "not an array of path strings"],
    ];
    for (const [content, needle] of cases) {
      if (content === null) rmSync(stepsPath, { force: true });
      else writeFileSync(stepsPath, content);
      reset();
      const code = await runCli(
        ["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath],
        deps(""),
      );
      expect({ content, code }).toEqual({ content, code: 2 });
      expect(text()).toContain(needle);
      expectNoBoxes();
    }
    // Every branch refused at the flag parser, so none ever built the store.
    expect(existsSync(freshDir)).toBeFalse();
  });

  test("--roster of separators only is flag-absent: roster-required, not count-mismatch", async () => {
    // `--roster ","` splits to ["",""], which round 7 S3a now refuses as empty segments
    // (previously: split→filter→empty list, caught by C2 empty-list refusal).
    reset();
    const d = fanoutDeps();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", ","],
      d,
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string }; /* dp:ok test-authored output: error envelope this run just emitted to errCaptured */
    expect(envelope.code).toBe("usage");
    expect(envelope.message).toBe("--roster contains an empty entry");
  });

  test("a refused race constructs no cost ledger — no db file appears anywhere", async () => {
    // INV-2: a refused fan-out mutates nothing. The loser ledger used to be
    // built BEFORE the briefs were validated, and its constructor creates its
    // db file even though race never reaches a loser to price.
    const d: Partial<FleetDeps> = {
      ...fanoutDeps(),
      readBrief: async () => '{"repoSlug":"nope"}', // parses fine; fails BriefSchema
    };
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
      d,
    );
    expect(code).toBe(2);
    // Both resolution shapes: default-layout sibling of .sandbox/runs, and
    // beside an explicitly-injected records dir.
    expect(existsSync(join(dir, ".sandbox", "cost-ledger.db"))).toBeFalse();
    expect(existsSync(join(dir, "runs", "cost-ledger.db"))).toBeFalse();
  });

  test("a failing advisory auto-rank warns on stderr and keeps the ARM-derived exit code", async () => {
    const d = fanoutDeps();
    const fanouts = join(dir, ".sandbox", "fanouts");
    let sabotaged = false;
    // The ack lines print BETWEEN fanout() returning and the advisory rank —
    // the one hook that makes ONLY the advisory step fail (delete the record
    // it is about to read) while both arms really did land ready.
    const saboteur = (s: string): void => {
      out(s);
      if (!sabotaged) {
        sabotaged = true;
        for (const f of readdirSync(fanouts)) rmSync(join(fanouts, f));
      }
    };
    reset();
    const code = await run(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
      saboteur,
      d,
      errOut,
    );
    // Two ready arms ⇒ success. The advisory failure used to flip this to a
    // reported refusal through the shared catch, turning N provisioned boxes
    // into an incident.
    expect(code).toBe(0);
    const envelope = JSON.parse(
      errCaptured.find((l) => l.includes("auto-rank-failed")) as string,
    ) as { code: string; message: string }; /* dp:ok test-authored output: warning envelope this run just emitted to errCaptured */
    expect(envelope.message).toContain("the fan-out itself succeeded");
    // The acks printed; the ranking line did not.
    expect(outOnly).toHaveLength(2);
  });

  // ─── fanout exit rule + stdout row contract (round-3 T-W1/T-W6) ────────────

  /**
   * Redirects `runMarkerPath()` (read at call time from `$QDS_RUN_ROOT`) into
   * the case tmpdir and returns a restore fn. Without it the race poller probes
   * `/run/journal/final.json` — a path this host may or may not answer — so
   * "no marker" and "marker present" both become properties of THIS case's
   * directory instead of the machine's.
   */
  function redirectRunRoot(subdir: string): { root: string; restore: () => void } {
    const prev = process.env.QDS_RUN_ROOT;
    const root = join(dir, subdir);
    mkdirSync(root, { recursive: true });
    process.env.QDS_RUN_ROOT = root;
    return {
      root,
      // Reflect.deleteProperty, not `= undefined`: Bun coerces an undefined
      // assignment into the STRING "undefined" (the QDS_FANOUTS_DIR note).
      restore: () => {
        if (prev === undefined) Reflect.deleteProperty(process.env, "QDS_RUN_ROOT");
        else process.env.QDS_RUN_ROOT = prev;
      },
    };
  }

  /** The arm-status rows a fanout run printed to stdout, parsed. */
  const armRows = (): { fanoutId: string; arm: number; runId: string; outcome: string; vmName?: string }[] =>
    outOnly.map((l) => {
      const row = JSON.parse(l) as Record<string, unknown>;
      // Ponytail: validate shape after parse - malformed lines fail with useful message
      expect(row).toHaveProperty("fanoutId");
      expect(row).toHaveProperty("arm");
      expect(row).toHaveProperty("runId");
      expect(row).toHaveProperty("outcome");
      return row as { fanoutId: string; arm: number; runId: string; outcome: string; vmName?: string };
    }); /* dp:ok test-authored output: arm rows this test's own CLI run just emitted */

  /**
   * The AC5 timing seams are FanoutDeps-only — FleetDeps forwards every key it
   * does not consume verbatim (`...seams`), so tests inject small values even
   * though the operator surface has no flag for them. The cast is the seam's
   * own shape, not a hole: production defaults are the AC numbers.
   */
  const raceTimingDeps = (): Partial<FleetDeps> =>
    ({ ...fanoutDeps(), pollIntervalMs: 10, perCallDeadlineMs: 5_000 }) as Partial<FleetDeps>;

  test("e2e: an arm classified setupFailed exits 1 — the failure half of the story:417 exit rule", async () => {
    const base = new FakeDriver(boxesDir);
    const d: Partial<FleetDeps> = {
      ...fanoutDeps(),
      // Item A of the fake gate is `exec true`; failing it fails EVERY arm at
      // its gate — dispatch refuses exit 3 per arm, which classifyArmFailure
      // turns into setupFailed (never armFailed, never lostRace).
      driver: driverWith(base, {
        exec: async (vm: string, argv: string[], stdin?: string) =>
          argv[0] === "true"
            ? { exitCode: 1, stdout: "", stderr: "box unreachable" }
            : base.exec(vm, argv, stdin),
      }),
    };
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
      d,
    );
    // 1, not 0 and not 2: the arms PROVISIONED then failed their gates — a
    // substrate outcome automation must alert on, not an argv mistake.
    expect(code).toBe(1);
    const rows = armRows();
    expect(rows.map((r) => r.outcome)).toEqual(["setupFailed", "setupFailed"]);
    // The gate runs AFTER provisioning, so each refusal names its box and the
    // optional vmName key rides along — see the row-contract pin below.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["arm", "fanoutId", "outcome", "runId", "vmName"]);
    // No auto-rank: only an all-ready best-of-n ranks.
    expect(outOnly.join("")).not.toContain('"scores"');
  });

  test("e2e: arms still undecided at the race ceiling report armUnknown and exit 1", async () => {
    const rr = redirectRunRoot("empty-run-root"); // no completion marker anywhere under it
    try {
      reset();
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
        // The tiny ceiling keeps the fleet lock held for milliseconds instead
        // of the production hour; the verdict either way is armUnknown.
        { ...raceTimingDeps(), ceilingMs: 120 } as Partial<FleetDeps>,
      );
      expect(code).toBe(1);
      const rows = armRows();
      expect(rows.map((r) => r.outcome)).toEqual(["armUnknown", "armUnknown"]);
      // INV-6's other half: unknown-state arms are never assumed losers —
      // neither box was torn down on a guess.
      for (const row of rows) expect(existsSync(join(boxesDir, row.vmName ?? ""))).toBeTrue();
    } finally {
      rr.restore();
    }
  });

  test("e2e: a race whose every non-winner is lostRace exits 0 — losing is not failing", async () => {
    // FakeDriver's copyFile refuses any remote path outside the box, so — like
    // patterns.test.ts's RaceFakeDriver — the in-box completion marker maps
    // onto <box>/journal/final.json and planting it is writing that file. The
    // FIRST marker probe belongs to arm 0 (index-order polling), so planting
    // at first probe makes the winner deterministic.
    const base = new FakeDriver(boxesDir);
    const markerPath = runMarkerPath();
    const boxMarker = (vm: string): string => join(boxesDir, vm, "journal", "final.json");
    let planted = false;
    const d = {
      ...fanoutDeps(),
      driver: driverWith(base, {
        exec: async (vm: string, argv: string[], stdin?: string) => {
          if (
            argv.length >= 3 &&
            argv[0] === "sh" &&
            argv[1] === "-c" &&
            typeof argv[2] === "string" &&
            argv[2].includes(markerPath)
          ) {
            // Since PF-3 (fc21f8b) the poller reads the marker by cat-ing
            // runMarkerPath() through this same exec channel (copyFile is
            // box-relative by driver contract). Answer the cat in-memory from
            // the planted box file, exactly as patterns.test.ts's
            // RaceFakeDriver does: letting it fall through to the `test -f`
            // probe returned exit 0 with EMPTY stdout, JSON.parse("") threw,
            // and every arm polled as "unusable" — no winner, race to ceiling.
            if (String(argv[2]).includes("cat ")) {
              try {
                return { stdout: readFileSync(boxMarker(vm), "utf8"), stderr: "", exitCode: 0 };
              } catch {
                return { stdout: "", stderr: "cat: marker vanished between test and read", exitCode: 1 };
              }
            }
            if (!planted) {
              planted = true;
              mkdirSync(dirname(boxMarker(vm)), { recursive: true });
              writeFileSync(boxMarker(vm), `${JSON.stringify({ ok: true })}\n`);
            }
            return base.exec(vm, ["sh", "-c", `test -f '${boxMarker(vm)}'`], stdin);
          }
          return base.exec(vm, argv, stdin);
        },
        copyFile: async (vm: string, remotePath: string, localPath: string) =>
          remotePath === markerPath
            ? base.copyFile(vm, boxMarker(vm), localPath)
            : base.copyFile(vm, remotePath, localPath),
      }),
      // The generous ceiling is the safety net: a fixture regression must fail
      // fast, not hold the fleet lock for the production hour.
      pollIntervalMs: 10,
      ceilingMs: 10_000,
    } as Partial<FleetDeps>;
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
      d,
    );
    // The load-bearing half of the story:417 rule — lostRace alone does NOT
    // fail. A race that produced its winner worked; reporting 1 here would
    // make automation alert on every successful race.
    expect(code).toBe(0);
    const rows = armRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outcome).toBe("ready");
    expect(rows[1]?.outcome).toBe("lostRace");
    // Winner stays up; the loser went through DF2.5 teardownSandbox
    // (harvested-then-destroyed), pricing its box hours into the loser ledger
    // the verb built.
    expect(existsSync(join(boxesDir, rows[0]?.vmName ?? ""))).toBeTrue();
    expect(existsSync(join(boxesDir, rows[1]?.vmName ?? ""))).toBeFalse();
    // Loser disposal marked the fleet lock destructive and CLEARED it —
    // release succeeded, so nothing survives the verb.
    expect(existsSync(join(dir, ".sandbox", "fleet.lock"))).toBeFalse();
    // 20s parity with fc21f8b's four patterns.test.ts race bumps: the
    // loser's REAL git teardown can outrun bun's 5s default under load.
  }, 20_000);

  test("a timed-out loser's late teardown still prices its box hours after the verb closed the ledger", async () => {
    // CodeRabbit round-5 warning: disposeLosers abandons a hung teardown at
    // its deadline, the verb's finally closes the loser ledger — and the
    // abandoned teardown's close step then ingested against the CLOSED
    // handle, losing the box-hours row and under-counting the ledger the cap
    // admits against. The hook now drops its reference on close, so the late
    // ingest re-opens; the event-id conflict rule keeps the row exactly-once.
    const base = new FakeDriver(boxesDir);
    const markerPath = runMarkerPath();
    const boxMarker = (vm: string): string => join(boxesDir, vm, "journal", "final.json");
    let plantedVm: string | undefined;
    let releaseDestroy: (() => void) | undefined;
    let barrierFor: string | undefined;
    const d = {
      ...fanoutDeps(),
      driver: driverWith(base, {
        exec: async (vm: string, argv: string[], stdin?: string) => {
          if (
            argv.length >= 3 &&
            argv[0] === "sh" &&
            argv[1] === "-c" &&
            typeof argv[2] === "string" &&
            argv[2].includes(markerPath)
          ) {
            // PF-3 (fc21f8b) moved the marker read onto this exec channel as
            // `cat` — answer it in-memory from the planted box file (same
            // RaceFakeDriver contract as patterns.test.ts), or every arm
            // polls "unusable" and the race spins to its ceiling.
            if (String(argv[2]).includes("cat ")) {
              try {
                return { stdout: readFileSync(boxMarker(vm), "utf8"), stderr: "", exitCode: 0 };
              } catch {
                return { stdout: "", stderr: "cat: marker vanished between test and read", exitCode: 1 };
              }
            }
            if (plantedVm === undefined) {
              plantedVm = vm;
              mkdirSync(dirname(boxMarker(vm)), { recursive: true });
              writeFileSync(boxMarker(vm), `${JSON.stringify({ ok: true })}\n`);
            }
            return base.exec(vm, ["sh", "-c", `test -f '${boxMarker(vm)}'`], stdin);
          }
          return base.exec(vm, argv, stdin);
        },
        copyFile: async (vm: string, remotePath: string, localPath: string) =>
          remotePath === markerPath
            ? base.copyFile(vm, boxMarker(vm), localPath)
            : base.copyFile(vm, remotePath, localPath),
        // The FIRST loser disposed parks at destroy until the verb has fully
        // returned — the abandoned-teardown window this test exists for. The
        // second loser tears down cleanly and prices pre-close, so the verb's
        // ledger close closes a LIVE handle — the exact fixture the warning
        // described.
        destroy: (vm: string): Promise<void> => {
          if (barrierFor === undefined && vm !== plantedVm) {
            barrierFor = vm;
            return new Promise<void>((resolve) => {
              releaseDestroy = resolve;
            });
          }
          return base.destroy(vm);
        },
      }),
      pollIntervalMs: 10,
      ceilingMs: 10_000,
      // Must clear the real git bundle-verify probe teardown runs first (same
      // constraint as patterns.test.ts's deadline pin — under host load that
      // probe alone can run 2s+, and a harvest-side abandon never reaches the
      // parked destroy), while still bounding the wait. Flake profile: same
      // documented family as the K8/AC5 load flakes — this test is
      // deterministic on an idle host and may abandon at harvest under
      // saturation (observed at LA 150+); re-run solo.
      loserTeardownTimeoutMs: 4_000,
    } as Partial<FleetDeps>;
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "race", "--n", "3", "--roster", "a,b,c"],
      d,
    );
    // Winner + one cleanly-disposed loser + one deadline-abandoned loser: the
    // race itself worked, and losing is not failing (:417).
    expect(code).toBe(0);
    const rows = armRows();
    expect(rows.map((r) => r.outcome)).toEqual(["ready", "lostRace", "lostRace"]);
    expect(barrierFor).toBeDefined();

    // THE WINDOW: runCli has resolved, so the finally already closed the
    // loser ledger. Release the barrier — the abandoned teardown's close step
    // ingests NOW, against a hook whose reference was dropped at close.
    (releaseDestroy as () => void)();
    const store = d.store as RunRecordStore;
    const hungRun = rows.find((r) => r.vmName === barrierFor)?.runId as string;
    const settleBy = Date.now() + 5_000;
    while (store.get(hungRun).closedAt === undefined && Date.now() < settleBy) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // toBeDefined, not toBeNull: the loop exits on TIMEOUT with closedAt
    // undefined, and `undefined` is not null — a null-only check would
    // false-pass exactly when the late teardown failed to settle.
    expect(store.get(hungRun).closedAt).toBeDefined();

    // deps() injects runsDir = <case>/runs, a non-default layout, so the
    // ledger sits INSIDE the records directory (costLedgerOpts' rule), not in
    // the .sandbox sibling the default layout uses.
    const db = new Database(join(runsDir, "cost-ledger.db"), { readonly: true });
    try {
      const priced = db
        .query("SELECT run_id FROM cost_events WHERE kind = 'box_hours'")
        .all() as { run_id: string }[];
      // BOTH losers priced: the clean sibling pre-close, the abandoned one
      // through the post-close re-open — one row each, exactly once.
      expect(priced.map((r) => r.run_id).sort()).toEqual(
        rows.slice(1).map((r) => r.runId as string).sort(),
      );
    } finally {
      db.close();
    }
  }, 30_000); // 4s loser deadline + the sibling's REAL teardown + the post-release settle window — past bun's 5s default

  test("loser-ledger hook: a close() that throws still drops the handle — the late ingest re-opens", () => {
    // Round 6 (CodeRabbit): the hook's close used to drop its reference AFTER
    // realLoserLedger?.close(), so a close that THREW left the reference on
    // the dead handle — and the abandoned-loser window (the test above) would
    // ingest on it, where bun:sqlite answers "Database has closed" and the
    // late box-hours row is lost. The drop now rides a finally; the throw
    // still propagates so the verb's finally keeps its exit-6 reporting.
    // Unit-level because a REAL CostLedger close cannot be made to throw
    // deterministically (bun's close is idempotent — a double close is a
    // no-op, verified against bun:sqlite directly).
    const ctx = {
      runId: "qds-20260101-00000a",
      repoSlug: "o/r",
      issueId: "7",
      requestId: "01234567-89ab-cdef-0123-456789abcdef",
    };
    const ingestCalls: number[] = [];
    let opened = 0;
    const hook = makeLoserLedgerHook(() => {
      opened += 1;
      const id = opened;
      return {
        ingestBoxHours: () => {
          ingestCalls.push(id);
          return { eventId: `evt-${id}`, inserted: true, unpriced: false };
        },
        // Handle #1's close fails — the exact failure mode the warning named.
        close:
          id === 1
            ? () => {
                throw new Error("simulated sqlite close failure");
              }
            : () => {},
      };
    });
    // First loser prices pre-close: handle #1 opens.
    expect(hook.ingestBoxHours(ctx)).toEqual({ eventId: "evt-1", inserted: true, unpriced: false });
    // The verb's finally closes it and the close FAILS — the failure must
    // reach the caller while STILL dropping the reference.
    expect(() => hook.close()).toThrow("simulated sqlite close failure");
    // THE WINDOW: the abandoned teardown's late ingest lands on a NEW handle,
    // not the one whose close failed.
    expect(hook.ingestBoxHours(ctx)).toEqual({ eventId: "evt-2", inserted: true, unpriced: false });
    expect(ingestCalls).toEqual([1, 2]);
    expect(opened).toBe(2);
    // The re-opened handle closes cleanly — no residual throw, no third open.
    hook.close();
    expect(opened).toBe(2);
    expect(ingestCalls).toEqual([1, 2]);
  });

  test("fanout stdout is a keyed contract: exact key sets per emitted line kind", async () => {
    // Story :499 documents what a caller parses off these lines. Pinning the
    // EXACT key sets (not just their presence) is what makes a silently added
    // column — the thing that breaks every downstream jq filter — a test
    // failure instead of a release note.
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "alpha,beta"],
      fanoutDeps(),
    );
    expect(code).toBe(0);
    const lines = outOnly.map((l) => JSON.parse(l) as Record<string, unknown>); /* dp:ok test-authored output: lines this test's own CLI run just emitted */
    expect(lines).toHaveLength(3);
    const [rowA, rowB, rankedLine] = lines;
    // Arm rows: the four fixed keys plus the optional vmName — ready arms carry it.
    const ARM_ROW_KEYS = ["arm", "fanoutId", "outcome", "runId", "vmName"];
    expect(Object.keys(rowA ?? {}).sort()).toEqual(ARM_ROW_KEYS);
    expect(Object.keys(rowB ?? {}).sort()).toEqual(ARM_ROW_KEYS);
    interface RankedRow {
      fanoutId: string;
      scores: { arm: number; runId: string; score: number | null; breakdown: Record<string, unknown> }[];
      tie: boolean;
      rationale: string;
      timings: Record<string, unknown>;
    }
    const ranked = rankedLine as unknown as RankedRow;
    expect(Object.keys(ranked).sort()).toEqual(["fanoutId", "rationale", "scores", "tie", "timings"]);
    expect(ranked.timings && Object.keys(ranked.timings)).toEqual(["rankMs"]);
    for (const s of ranked.scores) {
      expect(Object.keys(s).sort()).toEqual(["arm", "breakdown", "runId", "score"]);
      expect(Object.keys(s.breakdown).sort()).toEqual(["testPassRate", "uniqueFileCoverage"]);
    }
  });

  test("--steps-json over the 1 MiB cap refuses by name before any read or store build", async () => {
    // Mirrored literal, same discipline as MAX_BRIEF_BYTES above: importing the
    // constant would let an implementation that quietly lowered the cap pass
    // both sides of this boundary. The pad makes the file 1 MiB + 9 bytes.
    const stepsPath = join(dir, "steps-big.json");
    writeFileSync(stepsPath, JSON.stringify({ pad: "x".repeat(MAX_STEPS_BYTES) }));
    const freshDir = join(dir, "never-created-steps");
    reset();
    const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string }; /* dp:ok test-authored output: usage envelope this run just emitted to errCaptured */
    expect(envelope.code).toBe("usage");
    expect(envelope.message).toContain("--steps-json exceeds the 1 MiB cap");
    // Size-checked BEFORE the read and BEFORE the store constructor — the id
    // grammar's principle holding two flags further down the verb.
    expect(existsSync(freshDir)).toBeFalse();
    expectNoBoxes();
  });

  test("--steps-json pointing at a DIRECTORY is refused by name before any read or store build", async () => {
    // readBriefFile's posture: only a regular file has a size worth trusting.
    // A directory reports a small st.size that sails past the cap, and without
    // this proof the read would surface as a bare EISDIR instead of a named
    // refusal (a FIFO would block the read outright).
    const stepsPath = join(dir, "steps-dir");
    mkdirSync(stepsPath);
    const freshDir = join(dir, "never-created-steps-dir");
    reset();
    const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string }; /* dp:ok test-authored output: usage envelope this run just emitted to errCaptured */
    expect(envelope.code).toBe("usage");
    expect(envelope.message).toContain("is not a regular file");
    expect(existsSync(freshDir)).toBeFalse();
    expectNoBoxes();
  });

  test("rank accepts empty {} --steps-json with all scores null and exits 0", async () => {
    // Source accepts {} as valid steps-json (all arms unscored). This proves the
    // happy path: an empty object produces a ranking line with every score null.
    const fanoutsPath = join(dir, ".sandbox", "fanouts");
    const fstore = new FanoutRecordStore({ dir: fanoutsPath });
    const id = mintFanoutId();
    fstore.create({
      fanoutId: id,
      requestId: "01234567-89ab-cdef-0123-456789abcdef",
      pattern: "best-of-n",
      n: 2,
      pin: "c".repeat(40),
      createdAt: new Date().toISOString(),
      arms: [
        { arm: 0, runId: "qds-20260101-00000a", briefHash: "a".repeat(64) },
        { arm: 1, runId: "qds-20260101-00000b", briefHash: "a".repeat(64) },
      ],
      winner: null,
      rankedAt: null,
      closedAt: new Date().toISOString(),
    });
    const stepsPath = join(dir, "steps.json");
    writeFileSync(stepsPath, "{}");
    reset();
    const code = await runCli(["rank", id, "--dir", fanoutsPath, "--steps-json", stepsPath], deps(""));
    expect(code).toBe(0);
    const result = JSON.parse(outOnly[0] as string) as { /* dp:ok test-authored output: rank result line this run just emitted to outOnly */
      scores: { score: number | null }[];
      tie: boolean;
      rationale: string;
    };
    expect(result.scores).toHaveLength(2);
    expect(result.scores[0]?.score).toBeNull();
    expect(result.scores[1]?.score).toBeNull();
    expect(result.tie).toBe(false);
  });

  test("a fleet-busy race refusal creates NO loser cost ledger (INV-2: the money file follows admission)", async () => {
    // The loser ledger is LAZY end to end: the hook object itself does no I/O,
    // and the real CostLedger opens its SQLite file only on the first
    // ingestBoxHours — reachable exclusively from a LOSER'S teardown close
    // step, strictly past admission. A race refused at the lock therefore
    // leaves no money file behind (the pre-lazy build created one here).
    const heldLock = join(dir, ".sandbox", "fleet.lock");
    mkdirSync(dirname(heldLock), { recursive: true });
    const corpsePid = await deadPid();
    writeFileSync(
      heldLock,
      `${JSON.stringify({
        pid: corpsePid,
        pidStartTime: 1,
        createdAt: new Date().toISOString(), // YOUNG: refused, never stolen
        requestId: "busy-holder",
      })}\n`,
      { mode: 0o600 },
    );
    reset();
    const code = await runCli(
      ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
      deps(validBriefJson(dir)),
    );
    expect(code).toBe(5);
    expect(existsSync(join(dir, ".sandbox", "cost-ledger.db"))).toBeFalse();
    expect(existsSync(join(dir, "runs", "cost-ledger.db"))).toBeFalse();
    // 20s: deadPid() spawns+reaps a real child and the refusal path fsyncs
    // the lock — can outrun bun's 5s default under parallel-suite load.
  }, 20_000);

  test("an unknown --pattern refuses exit 2 before any construction side effect", async () => {
    // F-C1/F-C2: the pattern guard is hoisted ABOVE the constructors and above
    // every pattern-scoped check, so a typo'd pattern is a usage error that has
    // touched no disk — not a pin verdict, not a half-built fan-out record.
    const freshFanouts = join(dir, "fresh-fanouts");
    reset();
    const code = await runCli(
      // --dir points the (would-be) fan-outs store at a fresh path: the
      // strongest form of "constructed nothing" is that the very directory the
      // invocation was aimed at still does not exist afterwards.
      ["fanout", "--driver", "fake", "--pattern", "racee", "--n", "2", "--roster", "a,b", "--dir", freshFanouts],
      { ...deps(validBriefJson(dir)), lockPath: join(dir, ".sandbox", "fleet.lock") },
    );
    expect(code).toBe(2);
    const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string }; /* dp:ok test-authored output: usage envelope this run just emitted to errCaptured */
    expect(envelope.code).toBe("usage");
    // The echo passes redactSecrets, which strips the JSON quoting — pinned as
    // it actually renders.
    expect(envelope.message).toContain("unknown pattern: racee");
    expect(text()).toContain("pattern is one of best-of-n, many-stories, race");
    // No fan-outs store, no fleet lock, no boxes, no loser-ledger db: the verb
    // refused before anything that mkdirs was ever built.
    expect(existsSync(freshFanouts)).toBeFalse();
    expect(existsSync(join(dir, ".sandbox", "fleet.lock"))).toBeFalse();
    expectNoBoxes();
    expect(existsSync(join(dir, ".sandbox", "cost-ledger.db"))).toBeFalse();
    expect(existsSync(join(dir, "runs", "cost-ledger.db"))).toBeFalse();
  });

  // ─── CC-9: one structured line per verb, dispatch included ─────────────────

  describe("the CC-9 observability line", () => {
    let restoreLog: () => void;
    let entries: LogEntry[];

    beforeEach(() => {
      entries = [];
      restoreLog = setLogSink((e) => {
        entries.push(e);
      });
    });

    afterEach(() => {
      restoreLog();
    });

    /** The invocation's own line — `phase: "complete"`, one per run() call. */
    const verbLines = (): LogEntry[] =>
      entries.filter((e) => (e as unknown as { phase?: string }).phase === "complete");

    /**
     * Help requests carry the DISCRIMINATING `phase: "help"` (round 10, FC2):
     * before it, a help line was byte-for-byte a successful verb execution —
     * same status:"ok", same exitStatus:"success" — and dashboards counting
     * completions counted phantom teardowns.
     */
    const helpLines = (): LogEntry[] =>
      entries.filter((e) => (e as unknown as { phase?: string }).phase === "help");

    test("dispatch logs its verb line on success, carrying the ack's runId", async () => {
      const code = await runCli(["dispatch", "--driver", "fake"], deps(validBriefJson(dir)));
      expect(code).toBe(0);
      const { runId, requestId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
        runId: string;
        requestId: string;
      };

      const lines = verbLines();
      expect(lines).toHaveLength(1);
      const line = lines[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("dispatch");
      expect(line.operation).toBe("fleet.dispatch");
      expect(line.phase).toBe("complete");
      expect(line.exitCode).toBe(0);
      expect(line.exitStatus).toBe("success");
      // The brief owns the correlation id (INV-4-bis), so the CLI's line joins
      // the ack and the run's own lines rather than minting a third id.
      expect(line.requestId).toBe(requestId);
      expect(line.runId).toBe(runId);
    });

    test("dispatch logs its verb line on refusal too, with no runId to report", async () => {
      // Refused at the schema, before an id exists: the line is still owed, and
      // the runId is `null` rather than a fabricated one.
      const code = await runCli(["dispatch", "--driver", "fake"], deps('{"repoSlug":"nope"}'));
      expect(code).toBe(2);

      const lines = verbLines();
      expect(lines).toHaveLength(1);
      const line = lines[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("dispatch");
      expect(line.exitCode).toBe(2);
      expect(line.exitStatus).toBe("logic");
      expect(line.runId).toBeNull();
      expect(typeof line.requestId).toBe("string");
    });

    test("a help request logs its line too, phase:\"help\" — never a phantom completed verb (round 10)", async () => {
      // CC-9 says every verb logs one structured line, and help used to be the
      // exception — which made `fleet teardown <id> --driver real --help` (an
      // operator who meant to destroy a box and did not) the one invocation a
      // dashboard could not see at all. The verb is the one they typed, not
      // "help": a line reporting `help` cannot be told apart from a genuine
      // `fleet --help` in a per-verb rollup.
      //
      // Round 10 (FC2): logging it was only half the fix — the line was then
      // INDISTINGUISHABLE from a successful execution of that verb (`status:
      // "ok"`, `exitStatus: "success"`, `phase: "complete"`), so completion-
      // counting dashboards recorded a phantom teardown. The line now carries
      // `phase: "help"` — still exit 0, still success-classified, but no longer
      // countable as a completed verb.
      for (const [argv, verb] of [
        [["teardown", "qds-20260101-abcdef", "--driver", "fake", "--help"], "teardown"],
        [["dispatch", "--help"], "dispatch"],
        // Neither of these names a verb, so the line reports the help path itself.
        [["--help"], "help"],
        [["help"], "help"],
      ] as const) {
        entries.length = 0;
        reset();
        expect({ argv, code: await runCli([...argv], deps("")) }).toEqual({ argv, code: 0 });
        const lines = helpLines();
        expect({ argv, lines: lines.length }).toEqual({ argv, lines: 1 });
        const line = lines[0] as unknown as Record<string, unknown>;
        expect({ argv, verb: line.verb }).toEqual({ argv, verb });
        expect({ argv, operation: line.operation }).toEqual({ argv, operation: `fleet.${verb}` });
        expect(line.phase).toBe("help");
        expect(line.exitCode).toBe(0);
        expect(line.exitStatus).toBe("success");
        // No run was acted on, so there is none to report — `null`, never a
        // fabricated or argv-scraped id.
        expect(line.runId).toBeNull();
        expect(typeof line.requestId).toBe("string");
        // THE discriminating property: the completed-verb filter must NOT see
        // this line, or the fix is cosmetic.
        expect(verbLines()).toHaveLength(0);
      }
    });

    test("the log's runId is redacted first, then capped at the CLI's own bound", async () => {
      // Two streams, two owners, deliberately NOT collapsed — and now the SAME
      // order inside each. `assertFleetRunId` owns the operator-facing echo
      // (redact, then a 12-char head plus the true length); `bounded` owns the
      // LOG field and REDACTS FIRST, THEN cuts to its own 96. Capping before
      // redacting sliced a pasted credential across the 96-char boundary into
      // halves neither redaction rule matched, and nothing downstream of that
      // sink redacts at all — so the head rode out verbatim. What must hold of
      // both streams is that neither ever carries a matchable piece of the id.
      const long = "Q".repeat(300);
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, long], deps(""))).toBe(2);
      const line = verbLines()[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("teardown");
      // Secret-shaped argv: redaction eats it WHOLE, so no 96-char head of a
      // pasted credential ever reaches the log stream.
      expect(line.runId).toBe("«redacted»");
      expect(line.exitCode).toBe(2);
      // The envelope's echo stays the SHORTER, bounded form naming the true
      // length — visibly different from the log's placeholder, which is the
      // two-owners property this pins.
      const envelope = JSON.parse(errCaptured[0] as string) as { message: string };
      expect(envelope.message).toContain('supplied: "QQQQQQQQQQQQ…" (300 chars)');
      expect(envelope.message).not.toContain("Q".repeat(96));

      // The CLI's own cap is still there and observable on text redaction
      // LEAVES ALONE (hex-with-letters passes the opaque-token arm): 96 chars,
      // ellipsis, true length.
      const hexy = "b".repeat(300);
      entries.length = 0;
      reset();
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, hexy], deps(""))).toBe(2);
      const capped = (verbLines()[0] as unknown as Record<string, unknown>).runId;
      expect(capped).toBe(`${"b".repeat(96)}…(300 chars)`);
      // …and 200 KB of argv reaches neither stream when it is secret-shaped.
      expect(`${JSON.stringify(entries)} ${errCaptured.join("")}`).not.toContain(long);
      // A BENIGN id is different by design: redact() leaves hex alone, so the
      // operator-facing envelope may echo it whole — but the LOG field still
      // never does; its cap applies regardless of shape.
      expect(JSON.stringify(entries)).not.toContain(hexy);
    });

    test("a parse failure logs the attempted VERB, never a flag's value", async () => {
      // The line exists to be counted, and dashboards key on `verb`. Scanning
      // raw argv for the first token without a leading dash returned
      // `/srv/runs` here — the value `--dir` consumed — so a filesystem path
      // landed in the verb field and the failures this line counts went
      // missing from every per-verb rollup.
      const code = await runCli(["--dir", runsDir, "status", "--brief", "x"], deps(""));
      expect(code).toBe(2);

      const line = verbLines()[0] as unknown as Record<string, unknown>;
      expect(line.verb).toBe("status");
      expect(line.operation).toBe("fleet.status");
      expect(line.exitStatus).toBe("logic");
    });

    test("exit 1 is transient (retryable substrate), 2-6 are logic", async () => {
      const base = new FakeDriver(boxesDir);
      const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
      entries.length = 0;

      // exit 1: the substrate refused, not the operator — worth a retry. Read
      // off `status`, because a failing TEARDOWN is no longer this shape: it
      // throws inside the destructive phase, where scripts/fleet.ts holds the
      // run lock on purpose (`destructiveInFlight`) — see the exit-6 case
      // immediately below. `status` mutates nothing, so a substrate failure
      // there is exactly "retry me".
      expect(
        await runCli(["status", "--driver", "fake", "--dir", runsDir], {
          ...shared,
          driver: driverWith(base, {
            list: async () => {
              throw new Error("substrate unreachable");
            },
          }),
        }),
      ).toBe(1);
      expect((verbLines()[0] as unknown as Record<string, unknown>).exitStatus).toBe("transient");

      // exit 6, and NOT 1: the destroy failed after the teardown had begun
      // destroying the run, so the box may be gone with the key un-revoked and
      // the lock is deliberately kept for an operator. `transient` would send
      // automation back to a run whose every retry can only answer
      // `run-locked`.
      entries.length = 0;
      expect(
        await runCli(["teardown", "--driver", "fake", "--dir", runsDir, runId], {
          ...shared,
          driver: driverWith(base, {
            destroy: async () => {
              throw new Error("substrate refused the destroy");
            },
          }),
        }),
      ).toBe(6);
      expect((verbLines()[0] as unknown as Record<string, unknown>).exitStatus).toBe("logic");

      // exit 4: the id is wrong, and it will be wrong on every retry.
      entries.length = 0;
      expect(await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "no-such-run"], shared)).toBe(4);
      expect((verbLines()[0] as unknown as Record<string, unknown>).exitStatus).toBe("logic");

      // exit 6: the teardown SUCCEEDED and the cleanup wedged. Classified with
      // the operator errors and not with exit 1 on purpose — a retry cannot
      // clear a lock nothing will release, it can only refuse `run-locked`.
      entries.length = 0;
      reset(); // the first dispatch's ack is still in `captured`, and `find` takes the first
      expect(await runCli(["dispatch", "--driver", "fake"], shared)).toBe(0);
      const wedged = (JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string }).runId;
      const lock = join(runsDir, `${wedged}.lock`);
      entries.length = 0;
      try {
        expect(
          await runCli(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", wedged], {
            ...shared,
            driver: driverWith(base, {
              destroy: async (vm: string) => {
                await base.destroy(vm);
                writeFileSync(lock, "99999 someone-else 2026-01-01T00:00:00.000Z deadbeef\n");
              },
            }),
          }),
        ).toBe(6);
        const line = verbLines()[0] as unknown as Record<string, unknown>;
        expect(line.exitCode).toBe(6);
        expect(line.exitStatus).toBe("logic");
      } finally {
        // Ponytail: clean up the wedged lock so it doesn't leak into later tests
        if (existsSync(lock)) {
          rmSync(lock);
        }
      }
    });

    test("a fanout list-unverified refusal stamps its completion line transient", async () => {
      // The primitive attaches exitStatus "transient" to the ERROR itself
      // (fanout-primitive's invalid()): list-unverified is the SUBSTRATE
      // failing to answer, not the brief being wrong. logVerb derives from
      // exit code alone, and 5 reads as do-not-retry "logic" — so the
      // completion line must honor the error-carried override or automation
      // drops exactly the one retryable fan-out refusal.
      const base = new FakeDriver(boxesDir);
      const d: Partial<FleetDeps> = {
        ...fanoutDeps(),
        driver: driverWith(base, {
          list: async () => {
            throw new Error("provider unreachable");
          },
        }),
      };
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "race", "--n", "2", "--roster", "a,b"],
        d,
      );
      expect(code).toBe(5);
      expect(text()).toContain("list-unverified");
      const line = verbLines()[0] as unknown as Record<string, unknown>; /* dp:ok same read-back cast every sibling CC-9 case uses on the sink's LogEntry */
      expect(line.verb).toBe("fanout");
      expect(line.exitCode).toBe(5);
      expect(line.exitStatus).toBe("transient");
    });
  });

  // round-6 review: explicit-empty refusals (C1/C2/C3)
  describe("round-6 review refusals", () => {
    test("C1: --cap-micro-usd above $1M (1e12 µ$) is refused with domain bound", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b", "--cap-micro-usd", "1000000000001"],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toContain("--cap-micro-usd");
      expect(envelope.remediation).toContain("1000000000000");
    });

    test("C1: --cap-micro-usd accepts exactly $1M (1e12 µ$)", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b", "--cap-micro-usd", "1000000000000"],
        fanoutDeps(),
      );
      expect(code).toBe(0);
    });

    test("C1: --cap-micro-usd negative (-1) is refused (r7-T-b1)", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b", "--cap-micro-usd", "-1"],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toContain("--cap-micro-usd");
    });

    test("C2: --roster with empty string (\"\") is refused as explicit empty", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", ""],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      // Empty value is caught by parseValueFlags before our split/filter logic
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toContain("--roster");
      expect(envelope.message).toContain("non-empty");
    });

    test("C2: --roster with only commas (\",,,\") is refused as explicit empty (r7-S3a guard catches empty segments)", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", ",,,"],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toBe("--roster contains an empty entry");
      expect(envelope.remediation).toContain("non-empty");
    });

    test("C3: --steps-json entry with testResults but testsExecuted=false is refused", async () => {
      const freshDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
      freshScratchDirs.push(freshDir);
      const stepsPath = join(freshDir, "steps.json");
      writeFileSync(stepsPath, JSON.stringify({ "qds-123": { testsExecuted: false, testResults: { passed: 1, failed: 0 } } }));
      const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toContain("testResults but testsExecuted is false");
    });

    test("C3: --steps-json entry with testResults and testsExecuted=true is accepted", async () => {
      const freshDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
      freshScratchDirs.push(freshDir);
      const stepsPath = join(freshDir, "steps.json");
      writeFileSync(stepsPath, JSON.stringify({ "qds-123": { testsExecuted: true, testResults: { passed: 1, failed: 0 } } }));
      const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
      // Exits 4 because fanout doesn't exist, but shape validation passed
      expect(code).toBe(4);
      expect(text()).not.toContain("testResults");
    });

    test("C3: --steps-json entry with testsExecuted=true and no testResults is legal (passRate 0)", async () => {
      const freshDir = mkdtempSync(join(tmpdir(), "fleet-test-"));
      freshScratchDirs.push(freshDir);
      const stepsPath = join(freshDir, "steps.json");
      writeFileSync(stepsPath, JSON.stringify({ "qds-123": { testsExecuted: true } }));
      const code = await runCli(["rank", "fan-20260101-000000", "--dir", freshDir, "--steps-json", stepsPath], deps(""));
      // Exits 4 because fanout doesn't exist, but shape validation passed
      expect(code).toBe(4);
    });

    // round-7 review S3 findings
    test("S3a: --roster with empty segment (\"a,,b\") is refused with named error", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "3", "--roster", "a,,b"],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toBe("--roster contains an empty entry");
      expect(envelope.remediation).toContain("non-empty");
    });

    test("S3b: --roster with duplicate entries (\"x,x\") is refused naming the duplicate", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "x,x"],
        fanoutDeps(),
      );
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      expect(envelope.code).toBe("usage");
      expect(envelope.message).toContain("duplicate entry");
      expect(envelope.message).toContain("x");
      expect(envelope.remediation).toContain("unique");
    });

    test("S3c: rank refuses orphaned fanout record (n>0, arms:[]) with named error", async () => {
      // Create a custom fanouts directory and use it directly via --dir
      const customFanoutsDir = join(dir, "custom-fanouts");
      mkdirSync(customFanoutsDir, { recursive: true });
      const fstore = new FanoutRecordStore({ dir: customFanoutsDir });
      // Plant an orphaned record: n=2 but arms=[] (crash between create and mutate)
      const orphanedId = "fan-20260101-a1b2c3"; // Valid format: fan-YYYYMMDD-6hex
      fstore.create({
        fanoutId: orphanedId,
        requestId: "01234567-89ab-cdef-0123-456789abcdef",
        pattern: "best-of-n",
        n: 2,
        pin: "a".repeat(40),
        createdAt: new Date().toISOString(),
        arms: [], // Empty arms with n>0 = orphaned
        winner: null,
        rankedAt: null,
        closedAt: null,
      });
      // Use --dir to point directly at the fanouts directory (resolveFanoutsDir returns dir as-is)
      const code = await runCli(["rank", orphanedId, "--dir", customFanoutsDir], deps(""));
      expect(code).toBe(2);
      const envelope = JSON.parse(errCaptured[0] as string) as { code: string; message: string; remediation?: string };
      expect(envelope.code).toBe("invalid-fanout-record");
      expect(envelope.message).toContain("has n=2 but zero arms");
      expect(envelope.message).toContain("orphaned");
      expect(envelope.remediation).toContain(".sandbox/fanouts/");
    });

    test("S3 control: --roster with valid distinct entries (\"a,b\") still works", async () => {
      const code = await runCli(
        ["fanout", "--driver", "fake", "--pattern", "best-of-n", "--n", "2", "--roster", "a,b"],
        fanoutDeps(),
      );
      // Same fixture shape as the C1 accepts-exactly-$1M control: the verb runs
      // to completion (0) — roster parsing neither refuses nor derails it.
      expect(code).toBe(0);
      const errText = errCaptured.join("");
      expect(errText).not.toContain("--roster");
      expect(errText).not.toContain("usage");
    });
  });
});
