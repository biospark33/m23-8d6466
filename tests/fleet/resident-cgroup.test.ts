/**
 * DF3.6b — host-side coverage of the kernel-enforced resident memory bound.
 *
 * What a host-side suite CAN prove and what it cannot, stated once so nothing
 * here is mistaken for the make-or-break:
 *
 *   - PROVEN HERE: the delegated-subtree split and its idempotence, the leaf
 *     lifecycle (`memory.max` + `memory.oom.group=1` written, leaf removed on
 *     every exit path, a fresh leaf and a fresh `memory.peak` per solicitation),
 *     the numeric contract (the bound written is the bound supplied, byte for
 *     byte), the fail-closed placement wrapper's `|| exit 97` semantics against
 *     a positive control, the INV-MEM-2 Scope seam (absent bound ⇒ no cgroup
 *     machinery at all), and the arming refusal (AC3).
 *   - NOT PROVABLE HERE, at all: that the KERNEL OOM-kills the leaf (AC1). The
 *     enforcer is the kernel and darwin has no cgroups. That is the live in-box
 *     round's two legs, and this file never pretends otherwise — every test
 *     below drives the mechanism against a FAKE hierarchy in a temp dir, which
 *     proves the writes, never the enforcement.
 *
 * The fake hierarchy is a plain directory tree with the files the mechanism
 * reads and writes. It is honest about what it is: `cgroup.procs` is an ordinary
 * file here, so a write to it SUCCEEDS on any platform — which is exactly why
 * the placement test below drives the refusal through a MISSING leaf rather than
 * through a permission the fake cannot model.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  _injectRateSources,
  _lastSpawnArgvForTest,
  _injectSelfCgroupDir,
  _PLACEMENT_REFUSED_EXIT,
  _PLACEMENT_SCRIPT,
  _rmdirBoundedForTest,
  _resetCgroupSplit,
  CgroupUnenforceableError,
  DEFAULT_RESIDENT_SLUG,
  startResident,
  type ResidentSpawn,
} from "../../src/fleet/resident.ts";
import { PlacementRefusedError } from "../../src/phase-engine/steering.ts";
import type { RateSources } from "../../src/phase-engine/roster/validate.ts";

const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "df3-6b-cgroup-")));
const fakePi = join(import.meta.dir, "fixtures", "fake-pi-resident.ts");
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const SECRET = "sk-or-v1-df36b-resident-fixture-secret-00000011111";
const PROMPT = "Resident: read the dispatch brief and steer at the next point.";
/** 64 MiB — the story's E2E fixture bound, used here only as a distinctive
 *  number the assertions can read back byte for byte. */
const BOUND = 67_108_864;

const TEST_SOURCES: RateSources = {
  bundled: {
    unit: "usd-per-mtok",
    entries: new Map([
      [`openrouter/${DEFAULT_RESIDENT_SLUG}`, { input: 0.08, output: 0.18, cacheRead: 0.016, cacheWrite: 0.018 }],
    ]),
  },
  custom: { unit: "usd-per-mtok", entries: new Map() },
};

function brief(): Record<string, unknown> {
  return { repoSlug: "Quantum-Digital-Solutions/QDS-Factory", issueId: 36, commitSha: "b".repeat(40), manifestPath: "pipeline.yaml" };
}

function caseDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpRoot, `${name}-`)));
}

function piEnv(over: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(QDS_FAKE_PI_|FAKE_RESIDENT_)/.test(key)) continue;
    if (key === "QDS_RESIDENT_TIMEOUT_MS" || key === "QDS_PI_BIN") continue;
    env[key] = value;
  }
  return { ...env, OPENROUTER_API_KEY: SECRET, ...over };
}

function enabled(res: ReturnType<typeof startResident>): ResidentSpawn {
  expect(res).not.toHaveProperty("disabled");
  return res as ResidentSpawn;
}

/**
 * A fake delegated cgroup root: the two files `ensureDelegatedSubtree` reads,
 * plus whatever pids the caller wants the root to "hold". `controllers` is the
 * knob the unenforceable cases turn — an empty one is `Delegate=memory` absent.
 */
function fakeRoot(name: string, opts: { controllers?: string; procs?: string[] } = {}): string {
  const root = join(caseDir(name), "qds-run@r.service");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "cgroup.controllers"), opts.controllers ?? "cpu memory pids\n");
  writeFileSync(join(root, "cgroup.procs"), `${(opts.procs ?? []).join("\n")}\n`);
  writeFileSync(join(root, "cgroup.subtree_control"), "");
  return root;
}

/** Point the mechanism at a fake root and return it. */
function useRoot(root: string): string {
  _injectSelfCgroupDir(() => root);
  return root;
}

beforeEach(() => {
  chmodSync(fakePi, 0o755);
  _injectRateSources(TEST_SOURCES);
});
afterEach(() => {
  _injectRateSources(null);
  _injectSelfCgroupDir(null);
  _resetCgroupSplit();
});

// ─── the one-time delegated-subtree split ───────────────────────────────────

describe("DF3.6b — the delegated-subtree split (cgroup v2's no-internal-processes rule)", () => {
  test("moves EVERY process in the root into supervisor/ and enables +memory", () => {
    // MORE THAN ONE PID, deliberately: the root the split exists for holds the
    // engine AND, in-box, every tier-3 `dispatch_task` worker, and cgroup v2's
    // no-internal-processes rule refuses `+memory` while ANY of them is still
    // there. A single-pid fixture cannot tell a loop from a one-shot move — and
    // could not until the mechanism stopped truncating `cgroup.procs` on each
    // write (review round 3, finding 5).
    const root = useRoot(fakeRoot("split", { procs: [String(process.pid), "4242", "4243"] }));
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-split",
        sessionDir: caseDir("split-session"),
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      }),
    );
    expect(
      readFileSync(join(root, "supervisor", "cgroup.procs"), "utf8").split("\n").filter((l) => l !== ""),
    ).toEqual([String(process.pid), "4242", "4243"]);
    expect(readFileSync(join(root, "cgroup.subtree_control"), "utf8")).toBe("+memory");
    return spawn.stop();
  });

  test("is idempotent across engine restarts: a self already IN supervisor/ splits at the parent", () => {
    const root = fakeRoot("restart", { procs: [] });
    mkdirSync(join(root, "supervisor"), { recursive: true });
    writeFileSync(join(root, "supervisor", "cgroup.procs"), "");
    // A restarted engine reads its OWN cgroup as `.../supervisor` — the root to
    // split is its PARENT. Rooting at the leaf would nest supervisor/supervisor
    // and enable +memory on a cgroup that is not the delegated one.
    useRoot(join(root, "supervisor"));
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-restart",
        sessionDir: caseDir("restart-session"),
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      }),
    );
    expect(existsSync(join(root, "supervisor", "supervisor"))).toBe(false);
    expect(readFileSync(join(root, "cgroup.subtree_control"), "utf8")).toBe("+memory");
    return spawn.stop();
  });
});

// ─── AC3 / INV-MEM-2: unenforceable means NOT STARTED ───────────────────────

describe("DF3.6b AC3 / INV-MEM-2 — an unenforceable bound refuses the resident, typed", () => {
  test("Delegate=memory absent (no `memory` in cgroup.controllers) ⇒ CgroupUnenforceableError", () => {
    useRoot(fakeRoot("nodelegate", { controllers: "cpu pids\n" }));
    let thrown: unknown;
    try {
      startResident({
        brief: brief(),
        runId: "run-nodelegate",
        sessionDir: caseDir("nodelegate-session"),
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CgroupUnenforceableError);
    expect((thrown as Error).message).toContain("Delegate=memory");
  });

  test("no unified hierarchy at all (unreadable root) ⇒ CgroupUnenforceableError, and NOTHING is started", () => {
    const missing = join(caseDir("nov2"), "absent");
    useRoot(missing);
    const sessionDir = join(caseDir("nov2-session"), "sessions");
    expect(() =>
      startResident({
        brief: brief(),
        runId: "run-nov2",
        sessionDir,
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      }),
    ).toThrow(CgroupUnenforceableError);
    // The refusal precedes the session tree, so it leaves no filesystem side
    // effect and no session claim to leak — the INV-RES-3 rule, extended.
    expect(existsSync(sessionDir)).toBe(false);
  });

  test("a garbage bound is a CALLER fault, not an unenforceable box (it must not disable a resident over a typo)", () => {
    useRoot(fakeRoot("garbage"));
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      let thrown: unknown;
      try {
        startResident({
          brief: brief(),
          runId: "run-garbage",
          sessionDir: caseDir("garbage-session"),
          bin: fakePi,
          env: piEnv(),
          residentRssBytes: bad,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(CgroupUnenforceableError);
      expect((thrown as Error).message).toContain("residentRssBytes");
    }
  });

  test("the arming check runs against a REAL object: a root that reads enforceable but cannot hold a leaf still refuses", () => {
    const root = useRoot(fakeRoot("readonly"));
    // The controllers file says `memory`; the split succeeds; the probe leaf is
    // what fails. A check that stopped at "does the controller exist?" passes
    // this box and arms a resident whose bound can never be written.
    mkdirSync(join(root, "supervisor"), { recursive: true });
    chmodSync(root, 0o500);
    try {
      expect(() =>
        startResident({
          brief: brief(),
          runId: "run-readonly",
          sessionDir: caseDir("readonly-session"),
          bin: fakePi,
          env: piEnv(),
          residentRssBytes: BOUND,
        }),
      ).toThrow(CgroupUnenforceableError);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

// ─── INV-MEM-2 Scope: the host-side seam ────────────────────────────────────

describe("DF3.6b INV-MEM-2 Scope — an ABSENT bound runs no cgroup machinery at all", () => {
  test("omitting residentRssBytes arms normally and touches no hierarchy", async () => {
    // The injected resolver THROWS: if any cgroup code ran on this path, this
    // test fails loudly instead of passing for the wrong reason. This is what
    // keeps DF3.3's 42 host-side arming sites — and its INV-RES-3 second-mint
    // exhibit, a shipped security control — green on darwin.
    _injectSelfCgroupDir(() => {
      throw new Error("cgroup resolution must not run when residentRssBytes is absent");
    });
    const dir = caseDir("noseam");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-noseam",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
      }),
    );
    try {
      await spawn.caller.call(PROMPT);
      expect(spawn.lastMemory()).toBeNull();
      // The wrapper is absent from argv too: the child IS pi, not `sh -c`.
      const argv: string[] = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).argv;
      expect(argv.join(" ")).not.toContain("cgroup.procs");
    } finally {
      await spawn.stop();
    }
  });
});

// ─── the leaf lifecycle and the numeric contract ────────────────────────────

describe("DF3.6b — the per-solicitation leaf: armed with the bound, removed after the call", () => {
  test("memory.max carries the SUPPLIED bound byte for byte, and memory.oom.group is 1", async () => {
    // Two different bounds through the same code path: an implementation that
    // wrote a constant, a rounded value, or its own default passes a
    // single-value assertion and fails this one. This is the numeric contract
    // the DF3.6a handoff says has zero behavioural coverage anywhere else.
    //
    // DETERMINISTIC, not polled: the CHILD records the leaf's armed state from
    // inside the call, which is the only moment the leaf exists. An earlier
    // version polled the root from the parent and raced the `finally` teardown
    // — a flake on the one test that must never be quarantined as flaky.
    for (const bound of [BOUND, 12_345_678]) {
      const root = useRoot(fakeRoot(`bound-${bound}`));
      const dir = caseDir(`bound-${bound}-session`);
      const leafOut = join(dir, "leaf.json");
      const spawn = enabled(
        startResident({
          brief: brief(),
          runId: "run-bound",
          sessionDir: dir,
          bin: fakePi,
          env: piEnv({ QDS_FAKE_PI_EVENTS_ROOT: root, QDS_FAKE_PI_LEAF_OUT: leafOut }),
          residentRssBytes: bound,
        }),
      );
      try {
        // The arming probe leaf is removed, so the root is clean before the call.
        expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
        await spawn.caller.call(PROMPT);
        const armed = JSON.parse(readFileSync(leafOut, "utf8")) as {
          leaf: string;
          max: string | null;
          oomGroup: string | null;
        };
        expect(armed.max).toBe(String(bound));
        expect(armed.oomGroup).toBe("1");
        // The leaf pi ran in was this solicitation's own, and it is gone after.
        expect(armed.leaf).toBe("resident.run-bound.1");
        expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
      } finally {
        await spawn.stop();
        _resetCgroupSplit();
      }
    }
  });

  test("a second solicitation gets a FRESH leaf and a fresh memory.peak — asserted by VALUE, not by object identity", async () => {
    const root = useRoot(fakeRoot("two-calls"));
    const dir = caseDir("two-calls-session");
    // The fake stages `memory.peak` as 1000 × the leaf's own seq, so the two
    // calls produce DIFFERENT readings. Object identity would prove nothing
    // here: the resident rebuilds the reading as a fresh object literal every
    // call, so `.not.toBe` holds even for an implementation that re-read the
    // PREVIOUS leaf and reported its numbers again.
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-two",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_PEAK_BASE: "1000", QDS_FAKE_PI_EVENTS_ROOT: root }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(PROMPT);
      const first = spawn.lastMemory();
      expect(first?.boundBytes).toBe(BOUND);
      expect(first?.oomKilled).toBe(false);
      expect(first?.peakBytes).toBe(1000);
      expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
      await spawn.caller.call(PROMPT);
      expect(spawn.lastMemory()?.peakBytes).toBe(2000);
      expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
    } finally {
      await spawn.stop();
    }
  });

  test("stop() during an in-flight call tears the leaf down ONCE, reading the accounting before removing it", async () => {
    // Review round 6. `stop()` resumes on `proc.exited` alone, while the
    // interrupted call additionally drains both output streams — so stop()
    // reaches the teardown first essentially always. An implementation that
    // lets both sides run it raced them: stop() removed the leaf, the call's
    // own read then returned `{peakBytes:0, oomKilled:false}` silently for a
    // solicitation that may have been OOM-killed, the `resident_cgroup` line
    // was emitted with falsified values, and the call warned a spurious ENOENT.
    // Whoever clears the handle first owns the teardown; the other skips.
    const root = useRoot(fakeRoot("stop-race"));
    const dir = caseDir("stop-race-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-stoprace",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_MODE: "hang",
          QDS_FAKE_PI_EVENTS_ROOT: root,
          QDS_FAKE_PI_PEAK_BASE: "4096",
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 1\nmax 2\noom 0\noom_kill 0\noom_group_kill 0\n",
        }),
        residentRssBytes: BOUND,
      }),
    );
    const inFlight = spawn.caller.call(PROMPT).catch(() => undefined);
    // Wait for the child to have staged the leaf files, so the assertion below
    // distinguishes "read before removal" from "nothing was ever there".
    for (let i = 0; i < 400; i += 1) {
      const leaves = readdirSync(root).filter((e) => e.startsWith("resident."));
      if (leaves.length === 1 && existsSync(join(root, leaves[0] as string, "memory.peak"))) break;
      await Bun.sleep(5);
    }
    // Falling through the poll without the staged file would make every
    // assertion below hold vacuously — the same defect class as an
    // under-budgeted timeout. Assert the precondition rather than assume it.
    expect(readdirSync(root).some((e) => existsSync(join(root, e, "memory.peak")))).toBe(true);
    await spawn.stop();
    await inFlight;
    // The accounting survived the teardown — a racing implementation reports 0.
    expect(spawn.lastMemory()?.peakBytes).toBe(4096);
    // …and the leaf is gone, exactly once, with no second remove to fail.
    expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
  }, 20_000);

  test("the leaf is removed on a FAILING call too — an error path must not leak a cgroup", async () => {
    const root = useRoot(fakeRoot("failpath"));
    const dir = caseDir("failpath-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-fail",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_MODE: "fail" }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await expect(spawn.caller.call(PROMPT)).rejects.toThrow();
      expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
      // The kernel's account is still readable after a failed call: the read
      // happens BEFORE the removal, on every path.
      expect(spawn.lastMemory()).not.toBeNull();
    } finally {
      await spawn.stop();
    }
  });

  test("AC2 — the bound lands on the LEAF and nowhere else: never on the delegated root, never on supervisor/", async () => {
    // The wrong implementation this codebase is one line away from is NOT a
    // directive typed into the unit file (the test below covers that) — it is
    // writing `memory.max` on the DELEGATED ROOT that `ensureDelegatedSubtree`
    // returns. That root holds the engine and, in-box, every tier-3
    // `dispatch_task` worker, so a bound there charges a bun team-lead's memory
    // to a resident bound and trips on the first dispatch phase of every real
    // run (F064, already found and fixed once). It would leave the unit file
    // untouched and the leaf lifecycle intact.
    const root = useRoot(fakeRoot("ac2-root"));
    const dir = caseDir("ac2-session");
    const procsOut = join(dir, "leaf-procs.txt");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-ac2",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_EVENTS_ROOT: root, QDS_FAKE_PI_PROCS_OUT: procsOut }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(PROMPT);
      for (const where of [root, join(root, "supervisor")]) {
        for (const knob of ["memory.max", "memory.high", "memory.oom.group"]) {
          expect(existsSync(join(where, knob)), `${where}/${knob}`).toBe(false);
        }
      }
      // …and exactly ONE pid was ever placed in the leaf: pi's own, written by
      // the placement wrapper. A second pid would mean something that is not the
      // resident's process tree is inside the resident's bound.
      //
      // The wrapper APPENDS (`>>`), so this read-back is a property of the
      // mechanism rather than of shell redirection truncating a regular file —
      // an earlier `>` would have made the assertion unfalsifiable. What the
      // fake still cannot model is the kernel's own bookkeeping: on real
      // cgroupfs `cgroup.procs` also lists pi's DESCENDANTS, which inherit the
      // cgroup and never appear here. That half is the live round's.
      const placed = readFileSync(procsOut, "utf8").split("\n").filter((l) => l.trim() !== "");
      expect(placed).toHaveLength(1);
      expect(placed[0]).not.toBe(String(process.pid)); // never the engine's own pid
    } finally {
      await spawn.stop();
    }
  });

  test("AC2 — nothing writes a unit-level MemoryMax=: an engine-rooted bound is unrepresentable in the shipped unit", () => {
    // The F064 invariant, asserted where it can be: an engine-rooted bound
    // charges every in-box `dispatch_task` worker's memory to a resident bound.
    // The shipped unit must therefore carry NO unit-level memory directive —
    // only `Delegate=memory`, which hands the engine a subtree to root its own
    // leaf in.
    const unit = readFileSync(join(import.meta.dir, "..", "..", "oci", "exedev", "systemd", "qds-run@.service"), "utf8");
    expect(unit).toMatch(/^Delegate=memory$/m);
    expect(unit).not.toMatch(/^Memory(Max|High|Limit)=/m);
  });
});

// ─── AC4: the fail-closed placement wrapper ─────────────────────────────────

describe("DF3.6b AC4 — the placement wrapper refuses to become pi when the placement fails", () => {
  /** Runs the SHIPPED script (imported, never re-typed) against a cgroup dir,
   *  with a "pi" that leaves a marker file if it is ever exec'd. */
  async function runWrapper(script: string, cgroupDir: string): Promise<{ code: number | null; piRan: boolean }> {
    const dir = caseDir("wrapper");
    const marker = join(dir, "pi-ran");
    const proc = Bun.spawn(["sh", "-c", script, "_", cgroupDir, "sh", "-c", `: > "${marker}"`], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return { code: proc.exitCode, piRan: existsSync(marker) };
  }

  test("a placement that FAILS exits 97 and never execs pi", async () => {
    const gone = join(caseDir("gone"), "resident.1"); // the leaf a concurrent teardown removed
    const res = await runWrapper(_PLACEMENT_SCRIPT, gone);
    expect(res.code).toBe(_PLACEMENT_REFUSED_EXIT);
    expect(res.piRan).toBe(false);
  });

  test("POSITIVE CONTROL — the same script execs pi when the placement SUCCEEDS", async () => {
    // Without this, the test above would pass against a script that always
    // exits 97, which proves nothing about the wrapper.
    const leaf = caseDir("live-leaf");
    writeFileSync(join(leaf, "cgroup.procs"), "");
    const res = await runWrapper(_PLACEMENT_SCRIPT, leaf);
    expect(res.code).toBe(0);
    expect(res.piRan).toBe(true);
  });

  test("NEGATIVE CONTROL — an unconditional `;` wrapper execs pi UNBOUNDED on the same failure, and must not be what ships", async () => {
    // `;` is unconditional sequencing: the failed redirection prints to stderr
    // and falls straight through to `exec`, running pi with no memory.max —
    // the silent degradation to an unbounded agent INV-MEM-2 forbids.
    const unconditional = 'echo $$ > "$1"/cgroup.procs 2>/dev/null; shift; exec "$@"';
    const gone = join(caseDir("gone2"), "resident.1");
    const res = await runWrapper(unconditional, gone);
    expect(res.piRan).toBe(true);
    expect(res.code).toBe(0);
    // …and the shipped script does the opposite on the identical input.
    expect(await runWrapper(_PLACEMENT_SCRIPT, gone)).toEqual({ code: _PLACEMENT_REFUSED_EXIT, piRan: false });
  });

  test("the refusal is keyed on VERIFIED MEMBERSHIP, so a placement that silently did not take still exits 97", async () => {
    // FINDING 5 (review round 1). `cgroup.procs` rejects at WRITE time as well
    // as at open time — EBUSY when the target is not a leaf, EOPNOTSUPP, EINVAL
    // — and whether a `|| exit 97` on the redirection fires then depends on the
    // shell propagating a deferred write error: busybox `ash` returns 1, `dash`
    // raises an I/O error and exits 2. A generic non-zero exit is NOT the
    // `unenforceable` classification; the engine latches "degraded", which is
    // the misclassification AC4 exists to prevent.
    //
    // A true write-time rejection is a kernel behaviour no fake can produce, so
    // what is asserted here is the property that makes the shell irrelevant:
    // the wrapper reads `cgroup.procs` back and refuses unless its OWN pid is
    // in it. A leaf whose `cgroup.procs` accepts the write and does not retain
    // the pid — an ordinary empty file that something else truncates, the
    // portable stand-in — must still exit 97 and never exec pi.
    const leaf = caseDir("not-a-member");
    // Read-only file: the write fails or is dropped, and in EITHER case our pid
    // is not in it afterwards. A status-trusting wrapper is at the mercy of the
    // shell here; this one is not.
    writeFileSync(join(leaf, "cgroup.procs"), "");
    chmodSync(join(leaf, "cgroup.procs"), 0o444);
    try {
      expect(await runWrapper(_PLACEMENT_SCRIPT, leaf)).toEqual({
        code: _PLACEMENT_REFUSED_EXIT,
        piRan: false,
      });
    } finally {
      chmodSync(join(leaf, "cgroup.procs"), 0o644);
    }
  });

  test("a BOUNDED call actually spawns THROUGH the wrapper — not pi directly with a parent-side placement", async () => {
    // Rebase-review finding 4. Every other assertion in this file survives an
    // implementation that deletes the wrapper and writes `proc.pid` into
    // `cgroup.procs` from the PARENT right after `Bun.spawn`: the one-pid
    // read-back still sees one pid, the numeric contract and two-calls tests
    // never inspect argv, the exit-97 arm keys on the exit code plus `leafDir`
    // rather than on the wrapper, `runWrapper` exercises the script standalone,
    // and INV-MEM-3's test reads pi's own argv, which is identical either way.
    // That implementation re-opens precisely the window in which pi runs
    // unbounded — between `Bun.spawn` returning and the parent's write landing —
    // which is the only reason the wrapper exists.
    const root = useRoot(fakeRoot("spawn-shape"));
    const dir = caseDir("spawn-shape-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-shape",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(PROMPT);
      const argv = _lastSpawnArgvForTest();
      expect(argv[0]).toBe("sh");
      expect(argv[1]).toBe("-c");
      expect(argv[2]).toBe(_PLACEMENT_SCRIPT);
      // `_` is $0, then the leaf, then pi's own argv — positional (INV-MEM-3).
      expect(argv[3]).toBe("_");
      expect(argv[4]).toContain(`${root}/resident.run-shape.`);
      expect(argv[5]).toBe(fakePi);
    } finally {
      await spawn.stop();
    }
  });

  test("NEGATIVE CONTROL — an UNBOUNDED call spawns pi directly, with no wrapper at all", async () => {
    _injectSelfCgroupDir(() => {
      throw new Error("no cgroup machinery on an unbounded call");
    });
    const dir = caseDir("spawn-shape-unbounded");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-shape-unbounded",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv(),
      }),
    );
    try {
      await spawn.caller.call(PROMPT);
      const argv = _lastSpawnArgvForTest();
      expect(argv[0]).toBe(fakePi);
      expect(argv).not.toContain(_PLACEMENT_SCRIPT);
    } finally {
      await spawn.stop();
    }
  });

  test("INV-MEM-3 — pi's argv is passed POSITIONALLY: the prompt is never interpolated into a shell string", async () => {
    useRoot(fakeRoot("argv"));
    const dir = caseDir("argv-session");
    // A prompt carrying shell metacharacters. Interpolated into `sh -c`, the
    // substitution would run; passed positionally, it is one inert argv element.
    const hostile = `${PROMPT} $(touch ${join(dir, "pwned")}) \`touch ${join(dir, "pwned2")}\``;
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-argv",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_RECORD: join(dir, "record.json") }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(hostile);
      const rec = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as { argv: string[] };
      expect(rec.argv).toContain(hostile); // one element, verbatim
      expect(existsSync(join(dir, "pwned"))).toBe(false);
      expect(existsSync(join(dir, "pwned2"))).toBe(false);
      // The key stays env-borne, never argv (resident.ts's shipped rule,
      // unchanged by this wrapper).
      expect(rec.argv.join(" ")).not.toContain(SECRET);
      // The leaf the wrapper placed pi into was this root's, not some other
      // tree's — the argv element carrying it is asserted in the spawn-shape
      // test above; here it is enough that the call ran under a bound at all.
      expect(spawn.lastMemory()).not.toBeNull();
    } finally {
      await spawn.stop();
    }
  });

  test("a CHILD that exits 97 rejects with the typed PlacementRefusedError — the wrapper's refusal reaches the engine as a type", async () => {
    // The join neither half covered on its own (review round 3): the shell
    // script is exercised standalone through `runWrapper`, and the typed
    // rejection through a leaf-arming failure — but nothing ran a spawned child
    // that exits 97 from inside `call()`. Delete the exit-code arm and the rest
    // of the suite stays green while a real placement refusal degrades into the
    // generic non-zero path: `lastExit = "logic"`, a plain `Error`, and the
    // engine's one-way "degraded" latch instead of `unenforceable`.
    const root = useRoot(fakeRoot("exit97"));
    const dir = caseDir("exit97-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-exit97",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_EXIT: String(_PLACEMENT_REFUSED_EXIT) }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      const err = await spawn.caller.call(PROMPT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PlacementRefusedError);
      expect((err as PlacementRefusedError).exitCode).toBe(_PLACEMENT_REFUSED_EXIT);
      // pi never ran, so there is no process end to report — the busy/empty
      // prompt rule, applied to a refusal that happened before `exec`.
      expect(await spawn.exitStatus()).toBeNull();
      // …and the leaf is still torn down: a refusal must not leak a cgroup.
      expect(readdirSync(root).filter((e) => e.startsWith("resident."))).toEqual([]);
    } finally {
      await spawn.stop();
    }
  });

  test("NEGATIVE CONTROL — an UNBOUNDED call exiting 97 is an ordinary pi failure, not a placement refusal", async () => {
    // Without the `leafDir !== null` guard on that arm, a host-side resident
    // (no bound, no cgroup, no wrapper) exiting 97 would be reported as a
    // placement refusal for a placement that never happened.
    _injectSelfCgroupDir(() => {
      throw new Error("no cgroup machinery on an unbounded call");
    });
    const dir = caseDir("exit97-unbounded");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-exit97-unbounded",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({ QDS_FAKE_PI_EXIT: String(_PLACEMENT_REFUSED_EXIT) }),
      }),
    );
    try {
      const err = await spawn.caller.call(PROMPT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeInstanceOf(PlacementRefusedError);
      expect((err as Error).message).toContain("exited 97");
    } finally {
      await spawn.stop();
    }
  });

  test("a leaf that cannot be armed at solicitation time rejects with the TYPED PlacementRefusedError, not an opaque Error", async () => {
    const root = useRoot(fakeRoot("armfail"));
    const dir = caseDir("armfail-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-armfail",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv(),
        residentRssBytes: BOUND,
      }),
    );
    try {
      // The delegated root goes read-only between arming and the call — the
      // leaf can no longer be created, and an unbounded call must NOT be
      // issued. The engine classifies this by TYPE (its `instanceof` arm),
      // never through the one-way "degraded" latch.
      chmodSync(root, 0o500);
      const err = await spawn.caller.call(PROMPT).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(PlacementRefusedError);
      expect((err as PlacementRefusedError).exitCode).toBe(_PLACEMENT_REFUSED_EXIT);
    } finally {
      chmodSync(root, 0o700);
      await spawn.stop();
    }
  });
});

// ─── the OOM verdict discriminates an own-limit kill from a global one ──────

describe("DF3.6b — `oomKilled` means THIS leaf hit ITS OWN limit, never 'something OOM-killed pi'", () => {
  /** Drive `readLeaf` through a leaf whose `memory.events` the test writes. The
   *  leaf is the one a solicitation leaves behind, so the reading is taken the
   *  way production takes it: from the live leaf, before removal. */
  async function verdictFor(
    events: string,
    opts: { signalDeath?: boolean; peakBase?: string } = {},
  ): Promise<{ peakBytes: number; oomKilled: boolean } | null> {
    // `signalDeath` drives the CHILD's end, not the verdict: the verdict is the
    // counter conjunction alone. Kept so the kill cases exercise a realistic
    // process end alongside realistic counters.
    const root = useRoot(fakeRoot(`events-${Math.random().toString(36).slice(2)}`));
    const dir = caseDir("events-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-events",
        sessionDir: dir,
        bin: fakePi,
        // The fake pi writes the events file from INSIDE the leaf's lifetime,
        // which is the only window in which it exists.
        env: piEnv({
          QDS_FAKE_PI_EVENTS: events,
          QDS_FAKE_PI_EVENTS_ROOT: root,
          ...(opts.signalDeath === true ? { QDS_FAKE_PI_SIGKILL: "1" } : {}),
          ...(opts.peakBase === undefined ? {} : { QDS_FAKE_PI_PEAK_BASE: opts.peakBase }),
        }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      // A signal death rejects the call; a clean one resolves. Either way the
      // reading is taken in the call's `finally`, before the leaf is removed.
      await spawn.caller.call(PROMPT).catch(() => undefined);
      return spawn.lastMemory();
    } finally {
      await spawn.stop();
      _resetCgroupSplit();
    }
  }

  test("a GLOBAL OOM kill (oom_kill set, oom/oom_group_kill zero) is NOT this bound firing", async () => {
    // The box went into system-wide OOM and the kernel picked pi. `oom_kill`
    // counts processes in this cgroup killed by ANY OOM killer, so keying the
    // verdict on it stops the resident for a bound it never crossed and files a
    // watchdog_kill row whose detail contradicts itself (peak far below bound).
    // `peakBase` staged and asserted (round 21, after a sweep found this row
    // vacuous): the verdict here is `false`, which is ALSO what an
    // implementation that never opens the leaf at all returns, since
    // `readLeaf`'s catch yields `{peakBytes: 0, oomKilled: false}`. Reading a
    // distinctive peak back is what proves the counters above were actually
    // read rather than defaulted.
    const v = await verdictFor("low 0\nhigh 0\nmax 0\noom 0\noom_kill 1\noom_group_kill 0\n", {
      peakBase: "11111",
    });
    expect(v?.peakBytes).toBe(11111);
    expect(v?.oomKilled).toBe(false);
  });

  test("a GROUP kill on this leaf (oom_group_kill set) IS this bound firing", async () => {
    // `peakBase` is staged DELIBERATELY. Without it `memory.peak` reads 0, which
    // takes the `peakBytes === 0` escape in `reachedBound` — the row would then
    // read `true` on `ownLimit` alone and pin nothing about the BOUND its own
    // title names. Staging the peak AT the bound makes the floor decide for real.
    const v = await verdictFor("low 0\nhigh 2\nmax 5\noom 1\noom_kill 1\noom_group_kill 1\n", {
      signalDeath: true,
      peakBase: String(BOUND),
    });
    expect(v?.peakBytes).toBe(BOUND);
    expect(v?.oomKilled).toBe(true);
  });

  test("a real kill on a pre-5.19 kernel — no `memory.peak` at all — still counts", async () => {
    // The `peakBytes === 0` ESCAPE in `reachedBound`, pinned in its own right.
    // `memory.peak` landed in 5.19; before that the file does not exist and
    // `readLeaf` reads 0. The escape makes the floor fail OPEN there, because
    // suppressing a REAL kill on a MISSING measurement trades a false positive
    // for a false negative, and a resident silently blowing its bound every
    // solicitation while the run records a routine degrade is the worse
    // direction. Deliberate, so it gets a row: two other rows happened to
    // depend on this branch, but nothing NAMED it, and an escape nobody pins is
    // an escape a future tightening deletes without noticing.
    const v = await verdictFor("low 0\nhigh 1\nmax 4\noom 1\noom_kill 1\noom_group_kill 1\n", {
      signalDeath: true,
      // no peakBase — the fixture stages no `memory.peak` file at all
    });
    expect(v?.peakBytes).toBe(0);
    expect(v?.oomKilled).toBe(true);
  });

  test("a GLOBAL OOM that GROUP-KILLS through this leaf is still not this bound firing", async () => {
    // The case `oom_group_kill` alone gets wrong, and the reason the verdict is
    // a CONJUNCTION rather than a better-chosen single counter. On a global OOM
    // the kernel's `oom_domain` is the root, so it walks up from the victim,
    // finds THIS leaf's `oom.group=1`, group-kills it and increments
    // `oom_group_kill` HERE — on a leaf whose own limit never fired. `oom`
    // stays 0, which is what distinguishes it.
    // `peakBase` staged and asserted (round 21, after a sweep found this row
    // vacuous): the verdict here is `false`, which is ALSO what an
    // implementation that never opens the leaf at all returns, since
    // `readLeaf`'s catch yields `{peakBytes: 0, oomKilled: false}`. Reading a
    // distinctive peak back is what proves the counters above were actually
    // read rather than defaulted.
    const v = await verdictFor("low 0\nhigh 0\nmax 0\noom 0\noom_kill 1\noom_group_kill 1\n", {
      signalDeath: true,
      peakBase: "22222",
    });
    expect(v?.peakBytes).toBe(22222);
    expect(v?.oomKilled).toBe(false);
  });

  test("an own-limit OOM on a pre-5.17 kernel (no oom_group_kill line) still counts", async () => {
    // Peak staged for the same reason as the row above: the missing
    // `oom_group_kill` LINE is what this row exists to pin, but leaving
    // `memory.peak` unstaged would let it pass on the `peakBytes === 0` escape
    // and say nothing about the bound.
    const v = await verdictFor("low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n", {
      signalDeath: true,
      peakBase: String(BOUND),
    });
    expect(v?.peakBytes).toBe(BOUND);
    expect(v?.oomKilled).toBe(true);
  });

  test("counters set but the process SURVIVED is NOT a kill — an own-limit `oom` can be a graceful -ENOMEM", async () => {
    // Rebase-review finding 3. `oom` counts the times this cgroup hit its own
    // limit and could not reclaim; where the allocation can fail gracefully the
    // kernel returns -ENOMEM and the task lives. pi can take that, finish, and
    // the CALL can still reject afterwards — on a reply-artifact persist
    // failure, or a provider 429 classified transient. Reporting a kill there
    // files a `watchdog_kill` row with `status:"stopped"` and
    // `exitStatus:"overflow"` for a host-side fault, and those rows are D4's
    // tier-2 demotion evidence.
    // `peakBase` staged and asserted (round 21, after a sweep found this row
    // vacuous): the verdict here is `false`, which is ALSO what an
    // implementation that never opens the leaf at all returns, since
    // `readLeaf`'s catch yields `{peakBytes: 0, oomKilled: false}`. Reading a
    // distinctive peak back is what proves the counters above were actually
    // read rather than defaulted.
    const v = await verdictFor("low 0\nhigh 4\nmax 9\noom 1\noom_kill 0\noom_group_kill 0\n", {
      peakBase: "33333",
    });
    expect(v?.peakBytes).toBe(33333);
    expect(v).not.toBeNull();
    expect(v?.oomKilled).toBe(false);
  });

  test("a VOLUNTARY exit 137 is not proof of a kill — 137 is an exit code any binary can choose", async () => {
    // CodeRabbit, PR #264 round 2, kept as the REGRESSION row for the door it
    // came in through. Its counters are deliberately the graceful-`-ENOMEM`
    // shape; what differs is the exit code. A verdict that reads the exit shape
    // at all — and every version before ruling 8 did — files a `watchdog_kill`
    // here, because `QDS_PI_BIN` is free to exit 137 and DF3.3's branch treats
    // 137 as a signal death (a Bun-quirk fallback, correct for ITS purpose of
    // session quarantine). Under the conjunction the exit code is not consulted
    // and `oom_kill` is 0, so the answer falls out of the counters. The row
    // exists so a correction #5 that re-reads the exit shape fails here too.
    const root = useRoot(fakeRoot("voluntary-137"));
    const dir = caseDir("voluntary-137-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-137",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_EVENTS_ROOT: root,
          // The limit fired and reclaim failed — but the process chose to exit.
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 1\nmax 3\noom 1\noom_kill 0\noom_group_kill 0\n",
          QDS_FAKE_PI_EXIT: "137",
        }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(PROMPT).catch(() => undefined);
      expect(spawn.lastMemory()).not.toBeNull();
      expect(spawn.lastMemory()?.oomKilled).toBe(false);
    } finally {
      await spawn.stop();
    }
  });

  test("the TIMEOUT's own SIGKILL is not the kernel's — a wedged pi on a leaf with a graceful `oom` is a timeout", async () => {
    // Finding 2A. pi takes an own-limit `-ENOMEM`, survives, then wedges; the
    // native solicit timeout SIGKILLs it. Any verdict keyed on "did it die by
    // signal" reads true here and files a TIMEOUT as a `watchdog_kill` with
    // `exitStatus:"overflow"`. The counters do not: we killed it, and our
    // SIGKILL increments no OOM counter.
    const root = useRoot(fakeRoot("timeout-kill"));
    const dir = caseDir("timeout-kill-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-tmo",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_MODE: "hang",
          // 3000, not 150: at 150 ms the SIGKILL lands during the fixture's own
          // startup, BEFORE it stages `memory.events`, so the leaf is empty at
          // teardown and `oomKilled` reads false for the WRONG reason — the test
          // then passes against the very code it exists to catch. Measured: at
          // 150 ms it passes pre-rewrite; at 3000 ms it fails pre-rewrite with
          // `oomKilled: true`, which is the regression.
          QDS_RESIDENT_TIMEOUT_MS: "3000",
          QDS_FAKE_PI_EVENTS_ROOT: root,
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 2\nmax 4\noom 1\noom_kill 0\noom_group_kill 0\n",
          QDS_FAKE_PI_PEAK_BASE: "8192",
        }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      const pending = spawn.caller.call(PROMPT).then(
        () => null,
        (e: unknown) => e,
      );
      // DETERMINISTIC PRECONDITION, not a timing margin (round 21). The
      // 3000 ms budget makes the fixture winning the staging race LIKELY; this
      // poll makes it CHECKED. Without it the row's only protection against an
      // empty leaf is wall-clock luck, and on a loaded CI box a lost race
      // surfaces as a confusing red on a memory test rather than as what it is.
      // Same pattern as the stop()-race rows, which already do this.
      const staged = await (async () => {
        for (let i = 0; i < 400; i += 1) {
          const leaves = readdirSync(root).filter((e) => e.startsWith("resident."));
          if (leaves.length === 1 && existsSync(join(root, leaves[0] as string, "memory.peak"))) return true;
          await Bun.sleep(5);
        }
        return false;
      })();
      expect(staged, "the fixture never staged memory.peak — the row below would pass vacuously").toBe(true);
      const err = await pending;
      expect((err as Error).message).toContain("timed out");
      // The staging LANDED — without this a future timing shift silently
      // re-empties the leaf and the assertion below holds for the wrong reason,
      // which is exactly how this test was vacuous when first written.
      expect(spawn.lastMemory()?.peakBytes).toBe(8192);
      expect(spawn.lastMemory()?.oomKilled).toBe(false);
    } finally {
      await spawn.stop();
    }
  }, 20_000);

  test("stop()'s own SIGKILL on a LIVE child is not the kernel's either", async () => {
    // Finding 2B. The operator interrupts; `stop()` SIGKILLs a live child, so
    // the settled handle reads `signalCode: "SIGKILL"`. Reading the child's end
    // off the handle distinguishes only the child that had ALREADY exited — in
    // the ordinary Ctrl-C we killed it, and an exit-shape verdict reads true.
    const root = useRoot(fakeRoot("stop-kill"));
    const dir = caseDir("stop-kill-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-stopkill",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_MODE: "hang",
          QDS_FAKE_PI_EVENTS_ROOT: root,
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 2\nmax 4\noom 1\noom_kill 0\noom_group_kill 0\n",
        }),
        residentRssBytes: BOUND,
      }),
    );
    const inFlight = spawn.caller.call(PROMPT).catch(() => undefined);
    for (let i = 0; i < 400; i += 1) {
      const leaves = readdirSync(root).filter((e) => e.startsWith("resident."));
      if (leaves.length === 1 && existsSync(join(root, leaves[0] as string, "memory.events"))) break;
      await Bun.sleep(5);
    }
    // Falling through the poll without the staged file would make every
    // assertion below hold vacuously — the same defect class as an
    // under-budgeted timeout. Assert the precondition rather than assume it.
    expect(readdirSync(root).some((e) => existsSync(join(root, e, "memory.events")))).toBe(true);
    await spawn.stop();
    await inFlight;
    expect(spawn.lastMemory()).not.toBeNull();
    expect(spawn.lastMemory()?.oomKilled).toBe(false);
  }, 20_000);

  test("a REAL own-limit kill that surfaces as exit 137 with a null signalCode is still a kill", async () => {
    // Finding 3, the other direction. The file guards for a Bun quirk in which
    // a SIGKILL surfaces as 128+9 with no `signalCode`. A verdict keyed on the
    // exit shape has to choose: admit 137 and accept the voluntary-137 false
    // positive, or exclude it and MISS a real kill — a resident that blows its
    // bound every solicitation while the run records a routine degrade. The
    // counters need no choice: `oom_kill` is 1 here and 0 in the voluntary case.
    const root = useRoot(fakeRoot("quirk-137"));
    const dir = caseDir("quirk-137-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-quirk",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_EVENTS_ROOT: root,
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 3\nmax 7\noom 1\noom_kill 1\noom_group_kill 1\n",
          QDS_FAKE_PI_EXIT: "137",
        }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      await spawn.caller.call(PROMPT).catch(() => undefined);
      expect(spawn.lastMemory()?.oomKilled).toBe(true);
    } finally {
      await spawn.stop();
    }
  });

  test("an own-limit kill on a leaf whose process exited CLEANLY still reads as a kill", async () => {
    // The property ruling 8 asserts, pinned directly: the verdict does not
    // consult the process end AT ALL. A correction #5 that re-introduces an
    // exit-shape conjunction — for any reason, however locally sensible — fails
    // this test, which is the point of it. (The combination is reachable: with
    // `oom.group=1` the kernel kills the tree, but a shell wrapper or a
    // supervising child can still report a clean status to the parent.)
    const v = await verdictFor("low 0\nhigh 3\nmax 6\noom 1\noom_kill 1\noom_group_kill 1\n");
    expect(v?.oomKilled).toBe(true);
  });

  test("a SELF-CONTRADICTORY reading — `oom` set with the peak nowhere near the bound — is rejected", async () => {
    // This row pins the PEAK FLOOR, and nothing more. Per ruling 9 the floor is
    // a CONSISTENCY CHECK, not a discriminator: `oom > 0` already implies the
    // peak reached the bound (the failing charge is rolled back before the
    // watermark, so `peak >= bound - <failing charge>`), which makes the staged
    // combination below — `oom` 1 with a 4096-byte peak against a 64 MiB bound —
    // one the kernel cannot produce on a childless leaf. The floor rejects it
    // anyway, which is what this asserts, and it stops being merely implied the
    // moment the leaf gains children (`memory.events` aggregates upward, so a
    // child with a smaller limit could fire `oom` far below THIS bound).
    //
    // THIS ROW DOES NOT COVER the graceful-`-ENOMEM`-then-global-kill pairing.
    // This test was ORIGINALLY NAMED for that pairing and asserted the claim
    // ruling 9 retracted — that the floor separates it. It does not: in the real
    // pairing the early own-limit `oom` drives the peak TO the bound, so the
    // floor passes and the verdict is `true`. That case is the irreducible
    // residual, and the row directly below pins it as such.
    const v = await verdictFor("low 0\nhigh 5\nmax 9\noom 1\noom_kill 1\noom_group_kill 0\n", {
      signalDeath: true,
      peakBase: "4096",
    });
    expect(v?.peakBytes).toBe(4096);
    expect(v?.oomKilled).toBe(false);
  });

  test("the IRREDUCIBLE RESIDUAL reads `true` — a global kill after a graceful own-limit `oom`", async () => {
    // Ruling 9, stated as an executable fact rather than only as prose. pi takes
    // a graceful `-ENOMEM` against its own bound early (`oom` 1, survives, peak
    // driven to the bound), and later a `dispatch_task` worker puts the box into
    // system-wide OOM and the kernel picks pi (`oom_kill` 1, and `oom_group_kill`
    // 1 because the group kill is credited to whichever ancestor sets
    // `oom.group`, which for a global OOM is still this leaf). Every conjunct
    // holds, INCLUDING the floor, and the verdict is `true` — a MISLABEL.
    //
    // Asserting the wrong answer on purpose, because the alternative is a reader
    // assuming the case is handled. No readable cgroup v2 file separates it from
    // a genuine own-limit kill; the one true signal is `oom_memcg=` vs
    // `global_oom` in the kernel's OOM report, unreachable for `User=exedev`
    // without `CAP_SYSLOG`. If a future change makes this row go GREEN on
    // `false`, the residual has been closed — update this test and the ruling,
    // do not delete the row.
    const v = await verdictFor("low 0\nhigh 9\nmax 14\noom 1\noom_kill 1\noom_group_kill 1\n", {
      signalDeath: true,
      peakBase: String(BOUND),
    });
    expect(v?.peakBytes).toBe(BOUND);
    expect(v?.oomKilled).toBe(true);
  });

  test("a real kill whose peak stopped ONE ALLOCATION short of the bound still counts", async () => {
    // The peak conjunct needs slack, and the slack is not padding: `memory.peak`
    // tracks `memory.current`, and the charge that TRIGGERS the OOM is the one
    // that FAILS — it is never added to `current`. At the kill, usage sits below
    // `memory.max` by up to the failing charge — the `MEMCG_CHARGE_BATCH` path
    // (256 KiB) or order <= 3, NOT a THP fault, which cannot raise `oom` at all
    // (`mem_cgroup_oom()` skips `order > PAGE_ALLOC_COSTLY_ORDER` before the
    // event). The constant stays 2 MiB; this row pins the slack's EXISTENCE at
    // the shipped value, not its derivation. A strict `>=` reports that genuine kill as a routine degrade.
    // Here the peak is exactly `BOUND - 2 MiB`.
    const v = await verdictFor("low 0\nhigh 8\nmax 12\noom 1\noom_kill 1\noom_group_kill 1\n", {
      signalDeath: true,
      peakBase: String(BOUND - 2 * 1024 * 1024),
    });
    expect(v?.peakBytes).toBe(BOUND - 2 * 1024 * 1024);
    expect(v?.oomKilled).toBe(true);
  });

  test("a clean call reads false on every counter", async () => {
    // `peakBase` staged and asserted (round 21, after a sweep found this row
    // vacuous): the verdict here is `false`, which is ALSO what an
    // implementation that never opens the leaf at all returns, since
    // `readLeaf`'s catch yields `{peakBytes: 0, oomKilled: false}`. Reading a
    // distinctive peak back is what proves the counters above were actually
    // read rather than defaulted.
    const v = await verdictFor("low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n", {
      peakBase: "44444",
    });
    expect(v?.peakBytes).toBe(44444);
    expect(v?.oomKilled).toBe(false);
  });
});

// ─── M1: reclaimable pressure is the OTHER backstop, not a silent miss ──────

describe("DF3.6b M1 — reclaimable (file-backed) pressure classifies as a TIMEOUT, never as a silent pass", () => {
  test("a solicitation that thrashes at the limit times out, and its leaf reports NO kill even though the limit was hit", async () => {
    // The DoD's claim is a CLASSIFICATION claim: file-backed growth at
    // `memory.max` reclaims rather than OOMs, so the backstop that fires is the
    // per-call wall clock (`SOLICIT_TIMEOUT_MS`), not the bound — and a missing
    // `oom_kill` count on that path must read as "the other backstop fired",
    // never as "the bound is absent".
    //
    // WHAT IS AND IS NOT PROVEN HERE. Real reclaim is a kernel behaviour no
    // host-side fake can produce; the live round is the only place that lands.
    // The DoD says "skipped, not faked, where cgroups do not exist"; this test
    // is faked and unconditional, and the story's DoD sentence is amended to
    // match (ruling 6) rather than the claim being left to contradict the code.
    // The reason: a skip proves nothing anywhere, while a staged-counter
    // classification test fails for a real class of wrong implementation.
    // What IS proven, and what an earlier version of this test could not prove:
    // the leaf's own counters are STAGED WITH A LIMIT THAT WAS HIT AND
    // RECLAIMED (`max` non-zero, `oom`/`oom_group_kill` zero) and the verdict is
    // still `oomKilled: false` while the call classifies as a timeout. An
    // implementation reading `max` — the "times the limit was hit" counter,
    // which a thrashing solicitation increments on every reclaim — as a kill
    // reports a `watchdog_kill` for a run that only ran slowly, and MUST fail
    // this test. An earlier version asserted `oomKilled` on a leaf with NO
    // `memory.events` at all, where `false` was the unconditional default and
    // the assertion held for every implementation, right or wrong.
    const root = useRoot(fakeRoot("thrash"));
    const dir = caseDir("thrash-session");
    const spawn = enabled(
      startResident({
        brief: brief(),
        runId: "run-thrash",
        sessionDir: dir,
        bin: fakePi,
        env: piEnv({
          QDS_FAKE_PI_MODE: "hang",
          // 3000 ms, NOT 150 — a RACE MARGIN, and the honest account of it:
          // at 150 this row is not vacuous TODAY. Measured round 21: with the
          // peak assertion below in place it still passes at 150, so the fixture
          // does win the race on this machine. But it is the same race that DID
          // make the sibling timeout row vacuous in round 7 — the SIGKILL landing
          // during the fixture's own startup, before it stages `memory.events`,
          // leaving an empty leaf whose `{peakBytes: 0, oomKilled: false}`
          // default satisfies `expect(oomKilled).toBe(false)` for every
          // implementation. 150 ms is a margin against Bun's process startup on
          // a loaded machine, which is not a margin at all. The previous comment
          // claimed non-vacuity because the events file EXISTS — which is
          // precisely the thing the race takes away, so it was reasoning from
          // the assumption in question.
          QDS_RESIDENT_TIMEOUT_MS: "3000",
          // The limit was hit 17 times and reclaimed every time — the shape a
          // page-cache-thrashing solicitation leaves behind.
          QDS_FAKE_PI_EVENTS: "low 0\nhigh 9\nmax 17\noom 0\noom_kill 0\noom_group_kill 0\n",
          QDS_FAKE_PI_EVENTS_ROOT: root,
          // A distinctive peak, asserted below: it is what PROVES the fixture
          // staged the leaf before the kill, rather than the test reading a
          // default off an empty directory.
          QDS_FAKE_PI_PEAK_BASE: "424242",
        }),
        residentRssBytes: BOUND,
      }),
    );
    try {
      const pending = spawn.caller.call(PROMPT).then(
        () => null,
        (e: unknown) => e,
      );
      // DETERMINISTIC PRECONDITION, not a timing margin (round 21). The
      // 3000 ms budget makes the fixture winning the staging race LIKELY; this
      // poll makes it CHECKED. Without it the row's only protection against an
      // empty leaf is wall-clock luck, and on a loaded CI box a lost race
      // surfaces as a confusing red on a memory test rather than as what it is.
      // Same pattern as the stop()-race rows, which already do this.
      const staged = await (async () => {
        for (let i = 0; i < 400; i += 1) {
          const leaves = readdirSync(root).filter((e) => e.startsWith("resident."));
          if (leaves.length === 1 && existsSync(join(root, leaves[0] as string, "memory.peak"))) return true;
          await Bun.sleep(5);
        }
        return false;
      })();
      expect(staged, "the fixture never staged memory.peak — the row below would pass vacuously").toBe(true);
      const err = await pending;
      // The wall clock is what fired, and it says so.
      expect((err as Error).message).toContain("timed out");
      const mem = spawn.lastMemory();
      expect(mem).not.toBeNull();
      // THE NON-VACUITY PROOF, and it is this line rather than the comment: a
      // distinctive staged peak read back means the fixture reached the leaf
      // and the counters below were actually read. Without it, every assertion
      // here also passes against an empty leaf.
      // 424242 = PEAK_BASE x seq, and `seq` is 1 because this row makes exactly
      // ONE `call()`. If a future edit adds a second solicitation here, the
      // fixture stages 848484 on that leaf and this line fails with a value
      // that looks arbitrary — it is not, it is the base times the call count.
      expect(mem?.peakBytes).toBe(424242);
      expect(mem?.oomKilled).toBe(false);
      // The assertion above is discriminating rather than always-false because
      // the SAME staged-counter machinery reads `true` when the counters say an
      // own-limit kill AND the child died by signal — see the "`oomKilled`
      // means THIS leaf hit ITS OWN limit" block below, whose group-kill and
      // pre-5.17 cases stage exactly that and assert `true`.
    } finally {
      await spawn.stop();
    }
  }, 20_000);
});

// ─── the bounded EBUSY retry, which the fs-level fake cannot reach ──────────
//
// Found dead by a covering review (round 17): against the fake, `removeLeaf`
// has already emptied the leaf, so `rmdirSync` succeeds on attempt 0 and the
// retry's attempt cap, errno discrimination and backoff were never executed by
// any host-side test. The loop exists for a race only a real kernel produces —
// `cgroup.kill` SIGKILLs the leaf's tasks and `rmdir` returns EBUSY until the
// kernel finishes reaping them — so a wrong cap, an inverted errno check or an
// absent backoff would all have shipped green.
//
// These rows inject the remover. They pin the CONTRACT (how many attempts, on
// which errno, and that the original error is what surfaces); they do NOT prove
// the 4x25ms budget is enough for real reap latency under load, which is a
// kernel fact and belongs to the live leg.
describe("DF3.6b — removeLeaf's bounded EBUSY retry (injected remover)", () => {
  const ebusy = (): never => {
    const err = new Error("rmdir: EBUSY") as NodeJS.ErrnoException;
    err.code = "EBUSY";
    throw err;
  };

  test("a leaf that frees on the SECOND attempt is removed, not reported as a failure", () => {
    let calls = 0;
    _rmdirBoundedForTest("/fake/leaf", () => {
      calls += 1;
      if (calls === 1) ebusy();
    });
    expect(calls).toBe(2);
  });

  test("EBUSY to the end rethrows the ORIGINAL error after exactly four attempts, having WAITED", () => {
    let calls = 0;
    const started = Date.now();
    expect(() =>
      _rmdirBoundedForTest("/fake/leaf", () => {
        calls += 1;
        ebusy();
      }),
    ).toThrow("rmdir: EBUSY");
    // A FLOOR on elapsed time, because the attempt count alone does not pin the
    // BACKOFF: a reviewer checked, and deleting `Bun.sleepSync` from the loop
    // turned none of these rows red. Without a wait this is four instant rmdir
    // calls — a retry that cannot outlast the reap it exists to wait for, which
    // is precisely the bug that would ship green. Three sleeps at 25 ms is a
    // 75 ms floor; 60 ms leaves margin for a coarse clock without admitting a
    // deleted sleep. Asserted as a floor only — an upper bound would be flaky
    // under load and would pin nothing worth pinning.
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    // Four, not three and not five: `attempt >= LEAF_RMDIR_ATTEMPTS - 1` throws
    // ON the last attempt rather than after an extra one. An off-by-one here is
    // invisible in production — it only shortens or lengthens a window nobody
    // observes — which is why the count is asserted by value.
    expect(calls).toBe(4);
  });

  test("a NON-EBUSY errno is not retried — it surfaces on the first attempt", () => {
    let calls = 0;
    expect(() =>
      _rmdirBoundedForTest("/fake/leaf", () => {
        calls += 1;
        const err = new Error("rmdir: ENOTEMPTY") as NodeJS.ErrnoException;
        err.code = "ENOTEMPTY";
        throw err;
      }),
    ).toThrow("rmdir: ENOTEMPTY");
    // The discrimination matters in the fail-closed direction: retrying a
    // genuinely non-transient error would burn the budget and then report the
    // same failure later, while treating EBUSY as fatal would leak a cgroup on
    // every kill. NEGATIVE CONTROL for the errno check specifically — deleting
    // `code !== "EBUSY"` from the guard turns this row red.
    expect(calls).toBe(1);
  });

  test("an errno-less throw is not retried either", () => {
    let calls = 0;
    expect(() =>
      _rmdirBoundedForTest("/fake/leaf", () => {
        calls += 1;
        throw new Error("rmdir: no code at all");
      }),
    ).toThrow("no code at all");
    expect(calls).toBe(1);
  });
});
