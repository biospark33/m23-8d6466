/**
 * DF2.2 — the five-assertion setup gate.
 *
 * Every test drives the PRODUCTION gate through the production driver; only
 * the substrate is faked, and faked by content (the stubs print what a broken
 * box prints), never by exit status. The in-box script
 * (`src/providers/exedev/assertions-in-box.sh`) runs for real on the host
 * inside the fake box, so C/D/E are exercised end to end.
 */

import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PI_VERSION } from "../../../scripts/build-exedev-image.ts";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { IMAGE_MARKER_PATH } from "../../../src/providers/exedev/transport.ts";
import { ASSERTION_CODE } from "../../../src/providers/exedev/setup-gate.ts";
import { setupGate } from "../../../src/providers/exedev/setup-gate.ts";
import { RosterError } from "../../../src/phase-engine/roster/schema.ts";
import { provisionAdmittedRun, ProvisionRefusedError } from "../../../src/providers/driver.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
import {
  fakeExeDev,
  writePostureAttestation,
  type FakeCommand,
  type FakeExeDev,
} from "./fixtures/fake-exedev.ts";
import { runLocal } from "./helpers.ts";

const ROSTER = `
defaults:
  writes: []
roles:
  - name: architect
    model: openrouter/deepseek/deepseek-v4-flash-0731
    writes: []
`;

/** The in-box script, spawned directly by the shell-level tests below. */
const ASSERTIONS_SCRIPT = join(import.meta.dir, "../../../src/providers/exedev/assertions-in-box.sh");

/** The roster the direct-script tests share. Both slugs are real TIER-2 shapes:
 *  haiku carries n AND t (the F11 shredding trigger), deepseek carries neither
 *  (the control that kept passing live). Each test WRITES it: a sibling test is
 *  not a fixture, and `bun test -t "DF2.10 AC2"` runs exactly one of them. */
function writeShimRoster(dir: string): string {
  const path = join(dir, "f11-roster.yaml");
  writeFileSync(
    path,
    "defaults:\n  writes: []\nroles:\n  - name: lead\n    model: anthropic/claude-haiku-4.5\n    writes: []\n  - name: fixer\n    model: deepseek/deepseek-v3.2\n    writes: []\n",
    { mode: 0o600 },
  );
  return path;
}

/** The environment for a direct `assertions-in-box.sh` spawn. The host's
 *  OPENROUTER_API_KEY is STRIPPED for exactly the reason the fake substrate
 *  strips it before every in-box exec (fake-exedev.ts): a leaked host key lets
 *  E pass without DF2.3's delivery file, masking a missing key as a green gate.
 *  The script sources the key from its EnvFile argument, so nothing legitimate
 *  needs the inherited one. */
function shimEnv(binDir: string, home: string): Record<string, string | undefined> {
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: home, OPENROUTER_API_KEY: undefined };
}

/** The pi series the F14 absence tolerance was verified against — DERIVED from
 *  the pin, never re-typed (see the binding test below). */
const PI_SERIES = PI_VERSION.split(".").slice(0, 2).join(".");
/** One minor ahead of the pin: a series nobody reviewed, by construction, so a
 *  PI_VERSION bump can never quietly turn the refusing shim into a passing one. */
const UNREVIEWED_PI_SERIES = `${PI_SERIES.split(".")[0]}.${Number(PI_SERIES.split(".")[1]) + 1}`;

/** Seam calls the gate makes before the C/D/E script: 3 provisioning + 2 for A
 *  + 2 for B0's DF2.10 marker read (`test -f`, `cat`) + 2 for B's pi checks. The
 *  two timing regression tests below schedule against this count; it is asserted
 *  in the round-4 test so a call added or removed fails there, not silently. */
const TAXED_CALLS = 9;
/** Round-4's whole-gate budget, and the remaining time its tax burns down to.
 *
 *  A FIXED per-call tax cannot produce a known remaining time: remaining is
 *  `budget - REAL elapsed`, so every millisecond the host spends on nine spawns
 *  eats the window directly. At 500 ms × 9 against a 5 550 ms budget that left
 *  ~117 ms per call before the window closed, and the test failed at pristine
 *  HEAD under load — measuring the machine, not the gate. The tax instead burns
 *  the clock DOWN to `ROUND4_REMAINING_MS` on the last call before C/D/E, which
 *  is the condition under test stated directly; the budget only has to exceed
 *  what nine real spawns cost, and the slack below is ~10× the measured need. */
const ROUND4_BUDGET_MS = 15_000;
const ROUND4_REMAINING_MS = 500;
/** Round-5's per-call step. Its clock is FROZEN, so this costs no wall time —
 *  but `budgetFree()` hands the fake a REAL deadline it enforces with a
 *  SIGKILL, and that deadline is derived from the virtual remaining. A step too
 *  small starves the last calls of real time and a loaded host loses one to the
 *  kill, failing on A instead of C. The virtual arithmetic is unchanged by its
 *  value: nine steps consume exactly the budget either way. */
const FROZEN_STEP_MS = 4_000;

/** Hook budget for the setup/teardown of the fake substrate. bun's DEFAULT hook
 *  timeout is 5 s, and these hooks git-init a repo or `rm -rf` a tree holding a
 *  clone per fake box — on a loaded host that overruns and the file reports a
 *  bare `(unnamed)` failure naming nothing, which is a flake in the shape of a
 *  mystery. The tests themselves already carry 60 s budgets for the same reason. */
const HOOK_TIMEOUT_MS = 60_000;

/** A local git origin + the roster file + a fill'd box — the gate's preconditions. */
interface Box {
  vm: string;
  rosterPath: string;
}

/** DF2.3 already delivered the key BEFORE setup (Infra ordering). Planted
 *  HOST-side so the key never appears in the seam's argv corpus — which is
 *  exactly what the INV-4 leak scan asserts against. */
function deliverKey(fake: FakeExeDev, vm: string, key = "sk-test-0000000000000000000000", mode = 0o600): void {
  writeFileSync(join(fake.homeDir(vm), "app", ".env"), `OPENROUTER_API_KEY=${key}\n`, { mode });
}

/** The full create → fill chain on the fake substrate; returns the pinned SHA. */
async function makeBox(
  _fake: FakeExeDev,
  driver: ExeDevDriver,
  runId: string,
  originDir: string,
  rosterDir: string,
  opts: { fileContent?: string } = {},
): Promise<Box> { /* dp:ok a rejection here is the test failing — there is nothing to recover */
  await driver.create(runId);
  const rosterPath = join(rosterDir, `roster-${runId}.yaml`);
  writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
  await driver.fill(runId, {
    runId,
    repoUrl: `file://${originDir}`,
    commitSha: (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim(),
    workdir: "work",
  });
  if (opts.fileContent !== undefined) {
    // The clone's tracked file, re-written to simulate the measured failure:
    // an unsynced clone produced 5,641 zero-byte files and reported success.
    await driver.exec(runId, ["sh", "-c", `printf '%s' '${opts.fileContent}' > work/tracked.txt`]);
  }
  return { vm: runId, rosterPath };
}

describe("setup gate — defaults are the story's constants", () => {
  test("the fill workdir and DF2.3's env file never share a directory", async () => {
    const mod = await import("../../../src/providers/exedev/fill.ts");
    const { KEY_ENV_FILE } = await import("../../../src/providers/credentials.ts");
    // .env must sit OUTSIDE the clone: key-then-fill breaks the clone;
    // fill-then-key makes .env an untracked file A would false-fail on.
    const envDir = KEY_ENV_FILE.replace(/\/[^/]*$/, "");
    expect(mod.DEFAULT_FILL_WORKDIR).not.toBe(envDir);
    expect(mod.DEFAULT_FILL_WORKDIR.startsWith(`${envDir}/`)).toBe(false);
  });

  test("assertion timeout 60s, whole gate 300s, sentinel and env paths are the contract", async () => {
    const mod = await import("../../../src/providers/exedev/setup-gate.ts");
    expect(mod.DEFAULT_ASSERT_TIMEOUT_MS).toBe(60_000);
    expect(mod.DEFAULT_GATE_TIMEOUT_MS).toBe(300_000);
    expect(mod.DEFAULT_SENTINEL_PATH).toBe("/tmp/PROVISION_READY");
    // The env-file contract is DF2.3's constant, imported — not re-typed.
    // F3 (2026-08-24): HOME-relative — the real image's ssh HOME is the only
    // writable root, and /home/agent does not exist on it.
    expect(mod.DEFAULT_ENV_FILE).toBe("app/.env");
  });

  test("DF2.10 AC2: assertions-in-box.sh's PI_REVIEWED_SERIES tracks the pinned PI_VERSION", () => {
    // The pinned pi version is hand-typed in THREE places — oci/exedev/Dockerfile
    // (ARG PI_VERSION), scripts/build-exedev-image.ts (export const PI_VERSION),
    // and PI_REVIEWED_SERIES in assertions-in-box.sh; the test fake IMPORTS the
    // TS constant and is not a copy — and a shell script cannot import the TS
    // constant. Without this assertion, bumping PI_VERSION and forgetting the
    // shell constant leaves BOTH pi tests green (each derives its expected
    // version from the same import) while every REAL box refuses assertion D:
    // the exact failure AC2 exists to prevent, with the alarm deaf to it. This
    // is the binding, and it is the alarm. (The Dockerfile ARG is bound by the
    // build script, which passes PI_VERSION as its --build-arg.)
    const src = readFileSync(ASSERTIONS_SCRIPT, "utf8");
    const pinned = src.match(/^PI_REVIEWED_SERIES="([^"]*)"$/m);
    expect(pinned?.[1]).toBeDefined(); // the constant still exists under that name
    expect(pinned?.[1]).toBe(PI_SERIES);
  });
});

describe("setup gate — fill regression tests", () => {
  let fake: FakeExeDev;
  let driver: ExeDevDriver;
  let tempDir: string;
  let originDir: string;

  beforeAll(async () => {
    fake = fakeExeDev();
    driver = new ExeDevDriver({ run: fake.run });
    tempDir = mkdtempSync(join(tmpdir(), "qds-exedev-fill-"));
    originDir = join(tempDir, "origin");
    mkdirSync(originDir, { recursive: true });
    await runLocal(["git", "init", "-q", "-b", "main", originDir]);
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "base"]);
    writePostureAttestation(tempDir);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  test("round-6 regression: fill rejects symlinked workdir with code workdir-symlink (round-6)", async () => {
    await driver.create("fill-symlink");
    // Create a real symlink inside the box's home
    const linkTarget = join(fake.homeDir("fill-symlink"), "real-dir");
    const linkPath = join(fake.homeDir("fill-symlink"), "symlink-work");
    mkdirSync(linkTarget, { recursive: true });
    symlinkSync(linkTarget, linkPath);

    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    await expect(
      driver.fill("fill-symlink", {
        runId: "fill-symlink",
        repoUrl: `file://${originDir}`,
        commitSha: sha,
        workdir: linkPath,
      }),
    ).rejects.toThrow(/is a symlink.*fill requires a regular directory/);
  }, 60_000);

  test("round-6 regression: fill rejects repoUrl with semicolon (shell-hostile char)", async () => {
    await driver.create("fill-semi");
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    await expect(
      driver.fill("fill-semi", {
        runId: "fill-semi",
        repoUrl: "https://x.com/a;b",
        commitSha: sha,
      }),
    ).rejects.toThrow(/contains characters outside the plain-URL charset/);
  }, 60_000);

  test("round-6 regression: fill rejects repoUrl with ampersand (shell-hostile char)", async () => {
    await driver.create("fill-amp");
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    await expect(
      driver.fill("fill-amp", {
        runId: "fill-amp",
        repoUrl: "https://x.com/a&b",
        commitSha: sha,
      }),
    ).rejects.toThrow(/contains characters outside the plain-URL charset/);
  }, 60_000);
});

describe("setup gate — E2E chain (create → fill → setup)", () => {
  let fake: FakeExeDev;
  let driver: ExeDevDriver;
  let tempDir: string;
  let originDir: string;
  let rosterDir: string;
  let evidenceDir: string;

  beforeAll(async () => {
    fake = fakeExeDev();
    driver = new ExeDevDriver({ run: fake.run });
    tempDir = mkdtempSync(join(tmpdir(), "qds-exedev-gate-"));
    originDir = join(tempDir, "origin");
    rosterDir = join(tempDir, "rosters");
    evidenceDir = join(tempDir, "evidence");
    mkdirSync(originDir, { recursive: true });
    mkdirSync(rosterDir, { recursive: true });
    await runLocal(["git", "init", "-q", "-b", "main", originDir]);
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "base"]);
    writePostureAttestation(tempDir);
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }, HOOK_TIMEOUT_MS);

  function gateOpts(box: Box, patch = {}) {
    return {
      runId: box.vm,
      rosterPath: box.rosterPath,
      commitSha: "", // filled per test with the real HEAD
      workdir: "work",
      envFile: "home/app/.env",
      sentinelPath: "tmp/PROVISION_READY",
      evidenceDir,
      assertTimeoutMs: 30_000,
      gateTimeoutMs: 120_000,
      ...patch,
    };
  }

  test("AC1: all five assertions pass — ready, one {item, ok, note} each", async () => {
    // A tracked file with content, so the clone is a meaningful integrity check.
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "content"]);
    writeFileSync(join(originDir, "tracked.txt"), "the payload\n");
    await runLocal(["git", "-C", originDir, "add", "tracked.txt"]);
    await runLocal(["git", "-C", originDir, "-c", "user.email=test@qds", "-c", "user.name=test", "commit", "-q", "-m", "add tracked"]);
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();

    const box = await makeBox(fake, driver, "gate-e2e-1", originDir, rosterDir);
    // DF2.3 delivered the key BEFORE setup (Infra ordering); the fake box mirrors it.
    deliverKey(fake, box.vm);

    // The gate's own log lines are captured on this one happy path rather than
    // in a test of their own: a second full gate would be a second fake box to
    // provision and tear down for four assertions about one line.
    const events: Array<Record<string, unknown>> = [];
    const restore = setLogSink((e) => {
      events.push(e as Record<string, unknown>);
    });
    let result: Awaited<ReturnType<typeof driver.setup>>;
    try {
      result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    } finally {
      restore();
    }
    expect(result.ready).toBe(true);
    expect(result.failedItem).toBeUndefined();
    expect(result.assertionCode).toBeUndefined();

    // DF2.10: `gate_b0` is the item name every gate filter greps for (`gate_a`,
    // `gate_b`, `gate_cde`) — under any other name the marker assertion is
    // invisible to them. But the Observability Contract also names
    // `marker_assert_ms` by hand, and the item-derived `${item}_ms` key cannot
    // produce it once the item is `gate_b0`. Both must ride the SAME line.
    const b0 = events.filter((e) => e.operation === "exedev.gate" && e.item === "gate_b0");
    expect(b0.length).toBe(1);
    expect(typeof b0[0]?.gate_b0_ms).toBe("number");
    expect(typeof b0[0]?.marker_assert_ms).toBe("number");
    // >= 1, not merely "a number": 0 is the contract's never-evaluated
    // sentinel, and the fake substrate answers the marker read in well under a
    // millisecond — so an unclamped field publishes "this never ran" for the
    // assertion that just proved the box's image. `typeof` alone cannot tell
    // the two apart, which is how it shipped unclamped.
    expect(b0[0]?.marker_assert_ms as number).toBeGreaterThanOrEqual(1);
    // DF2.10 Observability Contract: `boot_ready_ms` rides the gate_a line —
    // wall time from gate entry to assertion A settling, the first
    // content-verified proof the box is up and answering. Like
    // `marker_assert_ms` it is hand-named by the contract, so the
    // item-derived key cannot produce it and it must ride the same line.
    const gateA = events.filter((e) => e.operation === "exedev.gate" && e.item === "gate_a");
    expect(gateA.length).toBe(1);
    expect(typeof gateA[0]?.boot_ready_ms).toBe("number");
    // A passed, so readiness WAS established: the window spans provision + A,
    // so it can never be smaller than A's own duration — and never 0, which is
    // the never-evaluated sentinel. The fake substrate settles A in under a
    // millisecond, so without the >= 1 clamp a genuinely-ready box would emit
    // the sentinel byte-for-byte.
    expect(gateA[0]?.boot_ready_ms as number).toBeGreaterThanOrEqual(1);
    expect(gateA[0]?.boot_ready_ms as number).toBeGreaterThanOrEqual(gateA[0]?.gate_a_ms as number);
    expect(b0[0]?.outcome).toBe("ok"); // the marker assertion PASSED on this path
    // The pre-DF2.10 item name is GONE: a dashboard keyed on it sees nothing,
    // and would read that as "the marker assertion never ran".
    expect(events.some((e) => e.item === "marker_assert")).toBe(false);
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
    for (const a of result.assertions) {
      expect(a.ok).toBe(true);
      expect(a.note.length).toBeGreaterThan(0);
    }
    expect(result.assertions[0]?.note).toMatch(/^A: HEAD [0-9a-f]{7,}, porcelain empty$/);
    expect(result.assertions[3]?.note).toMatch(/^D: provider cost\.total [0-9.e-]+ > 0; \d+\/\d+ models priced$/);
    expect(result.assertions[4]?.note).toMatch(/^E: credit remaining /);

    // AC7: QDS_TEAM_RUNNER=local landed in the box run environment, exactly once.
    const env = await driver.exec(box.vm, ["sh", "-c", "grep -c '^QDS_TEAM_RUNNER=local$' home/app/.env"]);
    expect(env.stdout.trim()).toBe("1");

    // Evidence artifact: outside .sandbox/runs (it would brick list()), 0600.
    const artifact = readFileSync(join(evidenceDir, "gate-e2e-1.json"), "utf8");
    const parsed = JSON.parse(artifact) /* dp:ok the artifact MUST parse — a throw is the test failing */ as { ready: boolean; assertions: unknown[] };
    expect(parsed.ready).toBe(true);
    expect(parsed.assertions.length).toBe(5);
  }, 60_000);

  test("AC2 negative control: exit-0 'No models available' fails B on CONTENT", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-b-trap", originDir, rosterDir);
    fake.configure(box.vm, { pi: { mode: "no-models", costTotal: 4.3e-05 } });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("B");
    expect(result.assertionCode).toBe(ASSERTION_CODE.B);
    expect(result.assertionCode).toBe(1); // A and B deliberately share 1
    const b = result.assertions.find((a) => a.item === "B");
    expect(b?.ok).toBe(false);
    expect(b?.note).toMatch(/no models available/i);
  }, 60_000);

  test("AC3: HEAD matches but porcelain is dirty → A fails", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-a-truncate", originDir, rosterDir, {
      fileContent: "", // truncate the tracked file to zero bytes
    });
    deliverKey(fake, box.vm);

    const events: Array<Record<string, unknown>> = [];
    const restore = setLogSink((e) => {
      events.push(e as Record<string, unknown>);
    });
    let result: Awaited<ReturnType<typeof driver.setup>>;
    try {
      result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    } finally {
      restore();
    }
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("A");
    expect(result.assertions[0]?.note).toMatch(/porcelain/);
    // INV-2: A failed, so NOTHING that spends ran — B/C/D/E absent from
    // `assertions` and NAMED in `notRun`: "it failed" and "it never ran" are
    // different facts, and a missing row states neither.
    expect(result.assertions.map((a) => a.item)).toEqual(["A"]);
    expect(result.notRun).toEqual(["B", "C", "D", "E"]);
    // Observability Contract: "a field never evaluated reports 0". A failed,
    // so boot readiness was NEVER established — the field must be 0, never a
    // measured-looking number on a box that failed its first proof.
    const gateA = events.filter((e) => e.operation === "exedev.gate" && e.item === "gate_a");
    expect(gateA.length).toBe(1);
    expect(gateA[0]?.boot_ready_ms).toBe(0);
  }, 60_000);

  test("a D-pre refusal records C as NOT RUN — an artifact with no C row states nothing", async () => {
    // The in-box script hoists D's version check ABOVE C's paid pings (INV-2:
    // a free refusal must not cost a fleet's spend), so a refusal there emits
    // exactly one line — {"item":"D"} — and exits 3. The host reads that as the
    // designed sequential stop and pushes only the D row, leaving C, the live
    // per-model ping whose absence is the whole POINT of the hoist, neither
    // failed nor skipped: an evidence artifact with no C row is
    // indistinguishable from a gate that was never asked to run one. The items
    // that did not run are recorded instead, while `failedItem`/`assertionCode`
    // stay D/3 — a fabricated failed C ahead of D would rewrite the very code
    // dispatch keys on into C's.
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-dpre-notrun", originDir, rosterDir);
    deliverKey(fake, box.vm);
    // The refusal's two preconditions, planted AFTER `configure()` (which
    // rewrites both files): an absent custom registry, and a pi reporting a
    // series nobody reviewed. The stub still answers `--list-models`, because B
    // has to PASS for the gate to reach the in-box script at all.
    rmSync(join(fake.homeDir(box.vm), ".pi", "agent", "models.json"), { force: true });
    writeFileSync(
      join(fake.boxDir(box.vm), "bin", "pi"),
      `#!/bin/sh\ncase "$1" in\n  --version) echo "${UNREVIEWED_PI_SERIES}.0";;\n  --list-models) echo "openrouter  deepseek/deepseek-v4-flash-0731  64k";;\nesac\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("D");
    expect(result.assertionCode).toBe(3); // unchanged: dispatch's cost-table code
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "D"]);
    expect(result.assertions.find((a) => a.item === "D")?.note).toMatch(/UNREVIEWED/);
    // THE assertion: C is on the record as not-run, and so is E.
    expect(result.notRun).toEqual(["C", "E"]);
    const artifact = JSON.parse(readFileSync(join(evidenceDir, `${box.vm}.json`), "utf8")) /* dp:ok the artifact MUST parse — a throw is the test failing */ as {
      notRun?: string[];
      assertionCode?: number;
    };
    expect(artifact.notRun).toEqual(["C", "E"]);
    expect(artifact.assertionCode).toBe(3);
  }, 60_000);

  test("AC4 landmine a: partial cost block (missing cacheWrite) → D fails naming the roster drop", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-d-partial", originDir, rosterDir);
    fake.configure(box.vm, {
      modelsJson: {
        models: {
          "deepseek/deepseek-v4-flash-0731": {
            cost: { input: 1.4e-07, output: 1.4e-07, cacheRead: 1.4e-08 }, // cacheWrite MISSING
          },
        },
      },
    });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("D");
    expect(result.assertionCode).toBe(3);
    const d = result.assertions.find((a) => a.item === "D");
    expect(d?.note).toMatch(/drops the (whole|entire) roster|roster drop/i);
    expect(d?.note).toMatch(/cacheWrite/);
  }, 60_000);

  test("AC4 landmine b: zero cost.input → D fails naming silent $0.0000", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-d-zero", originDir, rosterDir);
    fake.configure(box.vm, {
      modelsJson: {
        models: {
          "deepseek/deepseek-v4-flash-0731": {
            cost: { input: 0, output: 1.4e-07, cacheRead: 1.4e-08, cacheWrite: 1.4e-07 },
          },
        },
      },
    });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("D");
    const d = result.assertions.find((a) => a.item === "D");
    expect(d?.note).toMatch(/\$0(\.0+)?/);
    expect(d?.note).toMatch(/input/);
  }, 60_000);

  test("D: a provider HTTP error is distinct from a genuine zero-cost response", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-d-http", originDir, rosterDir);
    fake.configure(box.vm, { chatHttpCode: 500 });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("D");
    expect(result.assertionCode).toBe(3);
    const d = result.assertions.find((a) => a.item === "D");
    // The note must name the HTTP failure — not the misleading zero-cost
    // diagnosis a curl/transport error used to collapse into.
    expect(d?.note).toMatch(/HTTP 500/);
    expect(d?.note).toMatch(/provider\/transport error|unproven/i);
  }, 60_000);

  test("AC6: a stale /tmp/PROVISION_READY is cleared before provisioning", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-sentinel", originDir, rosterDir);
    // A previous run's sentinel, still warm.
    await driver.exec(box.vm, ["sh", "-c", "mkdir -p tmp && touch tmp/PROVISION_READY"]);
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(true);
    const sentinel = await driver.exec(box.vm, ["sh", "-c", "test -e tmp/PROVISION_READY && echo present || echo cleared"]);
    expect(sentinel.stdout.trim()).toBe("cleared");
  }, 60_000);

  test("AC6b: a null-limit (uncapped) key fails E — an uncapped key never gates green", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-e-uncapped", originDir, rosterDir);
    fake.configure(box.vm, { key: { limit: null, usage: 0.5 } });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("E");
    expect(result.assertionCode).toBe(4);
    const e = result.assertions.find((a) => a.item === "E");
    expect(e?.note).toMatch(/uncapped|null/i);
  }, 60_000);

  test("C fail: a model that answers with neither content nor reasoning", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-c-dead", originDir, rosterDir);
    fake.configure(box.vm, {
      chat: { default: { content: "", reasoning: "" }, byModel: {} },
    });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("C");
    expect(result.assertionCode).toBe(2);
    // Spend stopped at C: D and E never ran.
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C"]);
  }, 60_000);

  test("missing dependency is named, never a false fail (125-mapped)", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-dep-curl", originDir, rosterDir);
    fake.configure(box.vm, { curlMissing: true });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("C");
    expect(result.assertions.find((a) => a.item === "C")?.note).toMatch(/curl/);
  }, 60_000);

  test("B fail: pi absent from the box", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-b-missing", originDir, rosterDir);
    fake.configure(box.vm, { piMissing: true });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("B");
    expect(result.assertions.find((a) => a.item === "B")?.note).toMatch(/pi/);
  }, 60_000);

  test("INV-4/INV-5: the key never crosses the wire; a failing gate leaves the VM alive", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-inv45", originDir, rosterDir, { fileContent: "mutated" });
    const key = "sk-test-9988776655443322110099";
    await driver.exec(box.vm, ["sh", "-c", "true"]); // box touched, key planted host-side below
    deliverKey(fake, box.vm, key);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("A");

    // INV-4: the plaintext key appears in NO command the seam carried.
    const wire = fake.calls.map((a) => a.join(" ")).join("\n");
    expect(wire.includes(key)).toBe(false);

    // INV-5: the VM was not destroyed — no rm ever issued, box still listable.
    expect(fake.calls.some((a) => a[0] === "ssh" && a[1] === "exe.dev" && a[2] === "rm")).toBe(false);
    expect((await driver.list(box.vm)).map((v) => v.name)).toEqual([box.vm]);

    // INV-5/AC1: the failure payload carries the debug + teardown commands.
    expect(result.debugCommands.length).toBeGreaterThan(0);
    expect(result.debugCommands.every((c) => c.startsWith("ssh "))).toBe(true);
    // DF2.10 AC1c: the image the box actually booted is the first thing to look
    // at when B refuses, and the ONE command whose output the marker assertion
    // judged — an operator who cannot re-run it cannot check the gate's work.
    // Asserted by CONTENT, not by index: the list is allowed to grow.
    expect(result.debugCommands.some((c) => c.includes(`cat ${IMAGE_MARKER_PATH}`))).toBe(true);
    expect(result.teardownCommand).toContain(`rm ${box.vm}`);
  }, 60_000);

  test("the roster is an argument to the in-box script, never an environment variable", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-roster-arg", originDir, rosterDir);
    deliverKey(fake, box.vm);

    await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    // The C/D/E exec carried the roster path as an argv element (quoted), and
    // no command exported it into an environment.
    const boxCmds = fake.calls.filter((a) => a[1] === `${box.vm}.exe.xyz`).flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
    // The C/D/E command is the one carrying the roster path as an argv element.
    const gateCmd = boxCmds.find((c) => c.includes(box.rosterPath));
    expect(gateCmd).toBeDefined();
    expect(gateCmd).toContain(box.rosterPath);
    expect(gateCmd).toContain("home/app/.env"); // the env file rides along as an argument too
  }, 60_000);

  test("a malformed roster is refused before a single paid assertion runs", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-bad-roster", originDir, rosterDir);
    writeFileSync(join(rosterDir, "roster-gate-bad-roster.yaml"), "roles: []\n", { mode: 0o600 });
    deliverKey(fake, box.vm);

    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, rosterPath: join(rosterDir, "roster-gate-bad-roster.yaml") })),
    ).rejects.toThrow(/roster/);
    // No chat/completions call was made (the only spend path).
    const boxCmds = fake.calls.filter((a) => a[1] === `${box.vm}.exe.xyz`).flatMap((a) => (typeof a[2] === "string" ? [a[2]] : []));
    expect(boxCmds.some((c) => c.includes("chat/completions"))).toBe(false);
  }, 60_000);

  test("AC3 regression: a corrupt git index fails A even though stdout is empty", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-a-corrupt", originDir, rosterDir);
    // Corrupt the index: `git status --porcelain` exits 128 with EMPTY stdout —
    // "unknown" must never read as "clean".
    await driver.exec(box.vm, ["sh", "-c", "printf garbage > work/.git/index"]);
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.failedItem).toBe("A");
    expect(result.assertions[0]?.note).toMatch(/porcelain exited 128|index/i);
  }, 60_000);

  test("fail-closed: a script that dies mid-gate (exit 255 after C) is NOT ready — unproven D/E recorded", async () => {
    // Fresh fake whose seam drops the connection right after C's line — the
    // measured shape of a killed ssh. Partial evidence must never gate green.
    const dropFake = fakeExeDev({ truncateScript: true });
    try {
      const dropDriver = new ExeDevDriver({ run: dropFake.run });
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      await dropDriver.create("gate-drop-1");
      const rosterPath = join(rosterDir, "roster-gate-drop-1.yaml");
      writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
      await dropDriver.fill("gate-drop-1", { runId: "gate-drop-1", repoUrl: `file://${originDir}`, commitSha: sha, workdir: "work" });
      deliverKey(dropFake, "gate-drop-1");

      const result = await dropDriver.setup("gate-drop-1", {
        runId: "gate-drop-1", rosterPath, commitSha: sha, workdir: "work",
        envFile: "home/app/.env", sentinelPath: "tmp/PROVISION_READY",
        evidenceDir, assertTimeoutMs: 30_000, gateTimeoutMs: 120_000,
      });
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("D"); // first UNPROVEN item after the drop
      expect(result.assertionCode).toBe(3);
      const items = result.assertions.map((a) => a.item);
      expect(items).toEqual(["A", "B", "C", "D", "E"]);
      const d = result.assertions.find((a) => a.item === "D");
      expect(d?.note).toMatch(/exited 255 before|unproven|no stderr/i);
    } finally {
      dropFake.cleanup();
    }
  }, 60_000);

  test("fail-closed: exit 0 with only C's line is NOT ready — partial evidence is not proof (round-2)", async () => {
    // Exit 0 used to be accepted on results.length > 0 alone: a script that
    // proved C and stopped gated green with D/E never evidenced.
    const partialFake = fakeExeDev({ fabricateScriptEvidence: "c-only" });
    try {
      const partialDriver = new ExeDevDriver({ run: partialFake.run });
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      const box = await makeBox(partialFake, partialDriver, "gate-partial-c", originDir, rosterDir);
      deliverKey(partialFake, box.vm);

      const result = await partialDriver.setup(box.vm, gateOpts(box, { commitSha: sha }));
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("D"); // first UNPROVEN item after the partial evidence
      expect(result.assertionCode).toBe(3);
      expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
      const d = result.assertions.find((a) => a.item === "D");
      expect(d?.note).toMatch(/exited 0 before this assertion produced evidence/);
    } finally {
      partialFake.cleanup();
    }
  }, 60_000);

  test("fail-closed: exit 0 with duplicate lines is NOT ready — duplicates are not proof (round-2)", async () => {
    // A buggy or hostile box replays C twice plus D and exits 0: every line is
    // `ok`, but E was never proven and C was "proven" twice — not completeness.
    const dupFake = fakeExeDev({ fabricateScriptEvidence: "duplicates" });
    try {
      const dupDriver = new ExeDevDriver({ run: dupFake.run });
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      const box = await makeBox(dupFake, dupDriver, "gate-dup-c", originDir, rosterDir);
      deliverKey(dupFake, box.vm);

      const result = await dupDriver.setup(box.vm, gateOpts(box, { commitSha: sha }));
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("E"); // the never-proven item
      expect(result.assertionCode).toBe(4);
      expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "C", "D", "E"]);
      const e = result.assertions.find((a) => a.item === "E");
      expect(e?.note).toMatch(/exited 0 before this assertion produced evidence/);
    } finally {
      dupFake.cleanup();
    }
  }, 60_000);

  test("assertion codes are source-fixed: A/B share 1, C=2, D=3, E=4", () => {
    expect(ASSERTION_CODE).toEqual({ A: 1, B: 1, C: 2, D: 3, E: 4 });
  });

  test.todoIf(!process.env.QDS_EXEDEV_LIVE)(
    "DOD e2e: live-fire create → fill → setup against a real exe.dev account",
    async () => {
      // Evidence run. Required env: QDS_EXEDEV_REPO_URL (https clone source),
      // QDS_EXEDEV_SHA (pinned commit), QDS_EXEDEV_ROSTER (roster file path).
      // The key must already be delivered by DF2.3's lifecycle (Infra ordering).
      // This test FAILS loudly when the env is half-configured — a green
      // check that never touched exe.dev would be manufactured evidence.
      const repoUrl = process.env.QDS_EXEDEV_REPO_URL;
      const sha = process.env.QDS_EXEDEV_SHA;
      const roster = process.env.QDS_EXEDEV_ROSTER;
      if (!repoUrl || !sha || !roster) {
        throw new Error(
          "QDS_EXEDEV_LIVE is set but QDS_EXEDEV_REPO_URL / QDS_EXEDEV_SHA / QDS_EXEDEV_ROSTER are not — refusing to run a hollow live-fire",
        );
      }
      const liveDriver = new ExeDevDriver(); // the production ssh runner
      await liveDriver.whoami(); // preflight: the account is named before anything is created
      const runId = `df22-live-${Date.now().toString(36)}`;
      await liveDriver.create(runId);
      try {
        await liveDriver.fill(runId, { runId, repoUrl, commitSha: sha });
        const result = await liveDriver.setup(runId, { runId, rosterPath: roster, commitSha: sha });
        // The artifact is retained by the gate itself (.sandbox/setup-gate/);
        // teardown (DF2.5's rm) is a follow-up operator action, NEVER run here.
        expect(result.assertions.length).toBe(5);
        expect(result.ready).toBe(true);
      } finally {
        // INV-5 discipline on failure: the VM stays alive (evidence box) and
        // the teardown command is in the result payload. On success, print it.
        console.log(`live-fire done — teardown when ready: ssh exe.dev rm ${runId}`);
      }
    },
  );

  test("P3: workdir validation — ../evil and spaces reject", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-workdir", originDir, rosterDir);
    deliverKey(fake, box.vm);

    // evil: parent directory escape
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, workdir: "../evil" })),
    ).rejects.toThrow(/workdir.*not a plain path/i);
    // space: shell metacharacter
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, workdir: "work dir" })),
    ).rejects.toThrow(/workdir.*not a plain path/i);
  }, 60_000);

  test("P5b: gate timeout validation — zero timeouts reject", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-timeout", originDir, rosterDir);
    deliverKey(fake, box.vm);

    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, assertTimeoutMs: 0 })),
    ).rejects.toThrow(/must each be a finite number >= 1 ms/);
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, gateTimeoutMs: 0 })),
    ).rejects.toThrow(/must each be a finite number >= 1 ms/);
  }, 60_000);

  test("P1 budget: deterministic whole-gate budget enforcement", async () => {
    // Construct a slow driver: every execTimed call pays a 400ms tax before the
    // real seam. The seam delegates to slowFake — the SAME substrate the key is
    // delivered to and the spend scan reads — so both are non-vacuous.
    const slowFake = fakeExeDev();
    const slowRun: FakeCommand = async (argv, o) => {
      await new Promise((res) => setTimeout(res, 400)); // per-call delay
      return slowFake.run(argv, o);
    };
    const slowDriver = new ExeDevDriver({ run: slowRun });
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    await slowDriver.create("gate-budget");
    const rosterPath = join(rosterDir, "roster-gate-budget.yaml");
    writeFileSync(rosterPath, ROSTER, { mode: 0o600 });
    await slowDriver.fill("gate-budget", { runId: "gate-budget", repoUrl: `file://${originDir}`, commitSha: sha, workdir: "work" });
    deliverKey(slowFake, "gate-budget");

    try {
      // 3 provisioning calls + A (2 calls) at ~400 ms each ≈ 2.0 s > 1.5 s deadline
      const result = await slowDriver.setup("gate-budget", {
        runId: "gate-budget",
        rosterPath,
        commitSha: sha,
        workdir: "work",
        envFile: "home/app/.env",
        sentinelPath: "tmp/PROVISION_READY",
        evidenceDir,
        assertTimeoutMs: 30_000, // per-assertion budget is generous
        gateTimeoutMs: 1_500, // whole-gate deadline is tight — forces B to see exhaustion
      });
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("B");
      expect(result.assertions.find((a) => a.item === "B")?.note).toMatch(/budget exhausted/i);
      // No chat/completions (spend) ran — filter fake.calls like malformed-roster test
      const boxCmds = slowFake.calls.filter((a) => a[1] === `${"gate-budget"}.exe.xyz`).flatMap((a) =>
        typeof a[2] === "string" ? [a[2]] : [],
      );
      expect(boxCmds.some((c) => c.includes("chat/completions"))).toBe(false);
    } finally {
      slowFake.cleanup();
    }
  }, 60_000);

  test("P2 regression: E hardening — data non-dict fails with note", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-e-data-null", originDir, rosterDir);
    fake.configure(box.vm, { keyBody: { data: null } });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("E");
    const e = result.assertions.find((a) => a.item === "E");
    expect(e?.ok).toBe(false);
    // Script printed "data object" or similar; ensure note is non-empty
    expect(e?.note.length).toBeGreaterThan(0);
    expect(e?.note).toMatch(/data object|unparseable|limit/i);
  }, 60_000);

  test("P2 regression: E hardening — usage null is treated as 0, passes when limit - 0 > 0", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-e-usage-null", originDir, rosterDir);
    // limit 20 - usage(null→0) = 20 > 0, so E passes
    fake.configure(box.vm, { keyBody: { data: { limit: 20, usage: null } } });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(true);
    expect(result.failedItem).toBeUndefined();
    const e = result.assertions.find((a) => a.item === "E");
    expect(e?.ok).toBe(true);
  }, 60_000);

  test("round-4 regression: E rejects non-finite and boolean credit values (NaN passes isinstance; NaN <= 0 is false)", async () => {
    // python json.load accepts bare NaN, and isinstance(NaN, (int, float)) is
    // True — so {"limit": NaN} sailed past the old numeric check and NaN <= 0
    // never fired (round-4 review). bool is an int subclass in python, so a
    // JSON true limit computed remaining = 1. All four shapes must now fail E.
    const cases: Array<{ name: string; rawBody: string; note: RegExp }> = [
      { name: "gate-e-nan-limit", rawBody: '{"data":{"limit":NaN,"usage":0}}', note: /limit is not a finite number/ },
      { name: "gate-e-nan-usage", rawBody: '{"data":{"limit":20,"usage":NaN}}', note: /usage is not a finite number/ },
      { name: "gate-e-bool-limit", rawBody: '{"data":{"limit":true,"usage":0}}', note: /limit is not a finite number/ },
      { name: "gate-e-bool-usage", rawBody: '{"data":{"limit":20,"usage":true}}', note: /usage is not a finite number/ },
    ];
    for (const c of cases) {
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      const box = await makeBox(fake, driver, c.name, originDir, rosterDir);
      // keyRawBody, not keyBody: JSON.stringify turns NaN into null — the raw
      // knob is the only way to serve a bare NaN through the fake substrate.
      fake.configure(box.vm, { keyRawBody: c.rawBody });
      deliverKey(fake, box.vm);

      const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("E");
      expect(result.assertionCode).toBe(4);
      const e = result.assertions.find((a) => a.item === "E");
      expect(e?.ok).toBe(false);
      expect(e?.note).toMatch(c.note);
    }
  }, 60_000);

  test("round-4 regression: C/D/E starting with <1 s remaining gets the remaining time, never the 1 s floor", async () => {
    // TAXED_CALLS seam calls precede the C/D/E script (3 provisioning + 2 for A
    // + 2 for B's DF2.10 marker assertion + 2 for B's pi checks). The tax burns
    // the whole-gate budget down to ROUND4_REMAINING_MS on the LAST of them, so
    // the script starts inside the 1-999 ms window where the old deadline-derived
    // 1,000 ms floor granted a FULL second of spend past the whole-gate budget
    // (INV-2). The fix must hand the seam exactly the remainder: assert the
    // gate-script call saw timeoutMs < 1_000.
    //
    // Was 7 calls before DF2.10: gate B's `/etc/qds-image.json` marker assertion
    // adds TWO seam calls (readBoxFile's `test -f` then `cat`) ahead of C/D/E.
    const floorFake = fakeExeDev();
    const seen: Array<{ gateScript: boolean; timeoutMs?: number }> = [];
    let inGate = false; // makeBox's create/fill calls are not part of the schedule
    let gateStart = 0;
    let preCdeMs = 0; // what the nine calls REALLY cost — reported if the host was too slow
    let stallEndAt = 0; // when the ninth call's stall released — the post-stall window opens here
    let postStallMs = -1; // stall release → C/D/E launch: the OTHER window a slow host can eat
    const taxingRun: FakeCommand = async (argv, o) => {
      if (stallEndAt > 0 && postStallMs < 0 && argv.some((a) => a.includes("DF2.2 — setup-gate assertions"))) {
        // Measured on ARRIVAL, before the fake does any work: only the gate's
        // own remaining-time read sits between the stall's release and here.
        postStallMs = Date.now() - stallEndAt;
      }
      const res = await floorFake.run(argv, o);
      if (!inGate) return res;
      seen.push({
        gateScript: argv.some((a) => a.includes("DF2.2 — setup-gate assertions")),
        timeoutMs: o?.timeoutMs,
      });
      if (seen.length === TAXED_CALLS) {
        // The last call before C/D/E stalls until the budget is down to
        // ROUND4_REMAINING_MS. Stalling AFTER the seam returns is deliberate:
        // the fake enforces `timeoutMs` with a SIGKILL on its own subprocess, so
        // burning the clock here never eats any call's deadline.
        preCdeMs = Date.now() - gateStart;
        const stall = gateStart + ROUND4_BUDGET_MS - ROUND4_REMAINING_MS - Date.now();
        if (stall > 0) await new Promise((done) => setTimeout(done, stall));
        stallEndAt = Date.now();
      }
      return res;
    };
    const taxingDriver = new ExeDevDriver({ run: taxingRun });
    try {
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      const box = await makeBox(floorFake, taxingDriver, "gate-cde-floor", originDir, rosterDir);
      deliverKey(floorFake, box.vm);

      inGate = true;
      gateStart = Date.now(); // the gate reads its own a few ms later; the stall targets ≈500 ms, not 500
      const result = await taxingDriver.setup(
        box.vm,
        gateOpts(box, { commitSha: sha, gateTimeoutMs: ROUND4_BUDGET_MS }),
      );
      // A host slow enough to spend the whole budget on nine fake spawns would
      // fail the C/D/E-ran assertion below for a reason that has nothing to do
      // with the floor. Say so in the numbers rather than in a bare toContain.
      expect(preCdeMs).toBeLessThan(ROUND4_BUDGET_MS - ROUND4_REMAINING_MS);
      // The POST-stall window gets the same treatment: only ~ROUND4_REMAINING_MS
      // of budget survives the stall, so a GC pause or scheduler hiccup between
      // the stall's release and the C/D/E launch drives remaining to <= 0 and the
      // phase guard refuses — a failure that would otherwise masquerade as the
      // deadline-floor regression this test exists to catch. Named in numbers.
      expect(postStallMs).toBeGreaterThanOrEqual(0); // the launch was observed at the seam
      expect(postStallMs).toBeLessThan(ROUND4_REMAINING_MS);
      expect(result.assertions.map((a) => a.item)).toContain("C"); // C/D/E phase ran

      // The stall lands on the last call before C/D/E only for THIS many taxed
      // calls: a seam call added or removed ahead of C/D/E must fail here,
      // loudly, rather than silently sliding the window out from under the
      // assertions below.
      expect(seen.findIndex((c) => c.gateScript)).toBe(TAXED_CALLS);
      const gateCall = seen.find((c) => c.gateScript);
      expect(gateCall).toBeDefined(); // the phase guard let it start: 0 < remaining
      expect(gateCall?.timeoutMs).toBeLessThan(1_000); // the floor used to make this exactly 1_000
      expect(gateCall?.timeoutMs).toBeGreaterThanOrEqual(1);
    } finally {
      floorFake.cleanup();
    }
  }, 60_000);

  test("round-6 regression: gate timeout validation — NaN and Infinity reject (round-6)", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-timeout-nan", originDir, rosterDir);
    deliverKey(fake, box.vm);

    // assertTimeoutMs: NaN — non-finite rejects (matches the actual error format from setup-gate.ts:218)
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, assertTimeoutMs: Number.NaN })),
    ).rejects.toThrow(/must each be a finite number >= 1 ms/);
    // gateTimeoutMs: Infinity — non-finite rejects
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, gateTimeoutMs: Number.POSITIVE_INFINITY })),
    ).rejects.toThrow(/must each be a finite number >= 1 ms/);
  }, 60_000);

  test("round-6 regression: multiple missing deps — all named in one note (round-6)", async () => {
    // The fake substrate cannot make TWO C-phase deps vanish (piMissing fails B
    // first; python3 is the host's own /usr/bin/python3), so the script's dep
    // loop is proven directly: run assertions-in-box.sh under an EMPTY PATH —
    // command -v finds none of curl/python3/pi, and the round-6 loop must name
    // ALL of them in ONE exit-125 line (sequential discovery wasted cycles).
    const rosterFile = join(rosterDir, "gate-roster.yaml");
    const proc = Bun.spawn({
      cmd: ["/bin/sh", ASSERTIONS_SCRIPT, rosterFile, "/dev/null", "irrelevant-model"],
      env: { PATH: "", HOME: process.env.HOME ?? "/tmp" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(125);
    expect(stderr).toMatch(/missing dependency: curl python3 pi/);
    expect(stdout).not.toMatch(/^\{/m); // no evidence lines — the gate did not run
  }, 60_000);

  /** The PATH-shim used by the direct-script tests below: a fake curl that
   *  answers chat/completions and /api/v1/key like the real endpoints and
   *  (optionally) logs every -d body carrying "model": so a test can assert
   *  the EXACT ids the in-box script pinged. Handles -o/-w like real curl
   *  because assertion D reads status and body separately. */
  function installCurlShim(binDir: string, opts: { curlLog?: string } = {}): void {
    mkdirSync(binDir, { recursive: true });
    const logLines =
      opts.curlLog === undefined
        ? []
        : [
            `for a in "$@"; do`,
            `  printf '%s' "$a" | grep -q '"model":"' && printf '%s\\n' "$a" >> "${opts.curlLog}"`,
            "done",
          ];
    writeFileSync(
      join(binDir, "curl"),
      [
        "#!/bin/sh",
        // log bodies FIRST — the -o/-w parse below shifts $@ away
        ...logLines,
        "out=''; fmt=''",
        // snapshot argv BEFORE the shift-loop eats it — the URL case needs it
        "all=\"$*\"",
        "while [ \"$#\" -gt 0 ]; do",
        '  case "$1" in',
        "    -o) out=\"$2\"; shift 2;;",
        "    -w) fmt=\"$2\"; shift 2;;",
        "    *) shift;;",
        "  esac",
        "done",
        "emit() {",
        // real curl: payload to -o FILE if given, but -w's code ALWAYS to stdout
        `  if [ -n \"$out\" ]; then printf '%s' \"$1\" > \"$out\"; else printf '%s' \"$1\"; fi`,
        `  [ -n \"$fmt\" ] && printf '200'`,
        "}",
        "payload=''",
        `case " $all " in`,
        `  *chat/completions*) payload='{"choices":[{"message":{"content":"ready"}}],"usage":{"cost":{"total":0.00003}}}';;`,
        `  *) payload='{"data":{"limit":50000,"usage":10}}';;`,
        "esac",
        "emit \"$payload\"",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // pi stub: the script needs `command -v pi` to succeed AND — since DF2.10
    // re-aimed the F14 arm — `pi --version` to report the series the absence
    // tolerance was verified against. A real box's pi always answers this, so a
    // silent stub was doubling the substrate unfaithfully; an empty version now
    // means "unreviewed runtime" and correctly refuses D. python3 is symlinked
    // from the host so the emit/json machinery runs for real.
    writeFileSync(
      join(binDir, "pi"),
      // MEASURED on the real linux/amd64 factory image: `pi --version` prints
      // the bare version, no "pi " prefix. The Dockerfile's marker step asserts
      // exact equality against PI_VERSION, so the double must print what the
      // real binary prints — the extraction regex tolerates both forms, but a
      // double that differs from the substrate is where the next bug hides.
      // The version is the PIN, not a literal: a re-typed "0.84.4" here keeps
      // this shim on the reviewed series after a bump the real boxes followed.
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "${PI_VERSION}"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    symlinkSync("/usr/bin/python3", join(binDir, "python3"));
  }

  test("F11 regression: C pings each roster slug WHOLE — IFS must not shred slugs containing n/t", async () => {
    // The round-7 hermetic-parsing line `IFS=' \t\n'` is SINGLE-quoted, so IFS
    // became the literal characters {space, backslash, t, n} — and the C loop's
    // `for m in $Models` then word-split every slug ON THOSE CHARACTERS:
    // "anthropic/claude-haiku-4.5" shattered into the fields a, "", hropic/…,
    // each pinged as its own model id (measured live 2026-08-25, three gates
    // failed C with "from: a  hropic/…" while deepseek — no n/t — passed).
    // The instrument here mirrors that failure exactly: a shim PATH whose curl
    // RECORDS every model id it was asked to ping. The contract: one ping per
    // roster model, each body carrying the FULL slug.
    const binDir = join(rosterDir, "f11-shim-bin");
    const curlLog = join(rosterDir, "f11-curl.log");
    installCurlShim(binDir, { curlLog });
    const envFile = join(rosterDir, "f11-env");
    writeFileSync(envFile, "OPENROUTER_API_KEY=sk-test-f110000000000000000000\n", { mode: 0o600 });
    // D reads ~/.pi/agent/models.json and demands every model carry ALL FOUR
    // cost keys with input > 0 (INV: the factory must never report $0 spend).
    const piAgentDir = join(rosterDir, ".pi", "agent");
    mkdirSync(piAgentDir, { recursive: true });
    writeFileSync(
      join(piAgentDir, "models.json"),
      JSON.stringify({
        models: {
          "anthropic/claude-haiku-4.5": {
            cost: { input: 1e-6, output: 5e-6, cacheRead: 1e-7, cacheWrite: 1.25e-6 },
          },
          "deepseek/deepseek-v3.2": {
            cost: { input: 2.8e-7, output: 4.2e-6, cacheRead: 2.8e-8, cacheWrite: 3.5e-7 },
          },
        },
      }),
      { mode: 0o600 },
    );
    const rosterFile = writeShimRoster(rosterDir);
    try {
      rmSync(curlLog, { force: true });
      const proc = Bun.spawn({
        cmd: ["/bin/sh", ASSERTIONS_SCRIPT, rosterFile, envFile, "anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"],
        // binDir PREPENDS to the host PATH: the three shims shadow the real
        // binaries while /bin/sh's own utilities (grep, awk, rm) stay reachable.
        env: shimEnv(binDir, rosterDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const lines = stdout.trim().split("\n").filter((l) => l.startsWith("{"));
      const parsed = lines.map((l) => JSON.parse(l) as { item: string; ok: boolean; note: string });
      const c = parsed.find((r) => r.item === "C");
      expect(c?.ok).toBe(true);
      expect(c?.note).toMatch(/2\/2 roster models answered/);
      // THE instrument: every model id anything in the script pinged. C's loop
      // contributes the first two, IN ROSTER ORDER; D re-pings the first slug
      // for the cost table. No fragment ("a", "", "hropic/…") may appear.
      const bodies = (await Bun.file(curlLog).text()).trim().split("\n");
      const models = bodies.map((b) => b.replace(/^.*"model":"([^"]*)".*$/, "$1"));
      expect(models.slice(0, 2)).toEqual(["anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"]);
      for (const m of models) {
        expect(["anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"]).toContain(m);
      }
      expect(exitCode).toBe(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(curlLog, { force: true });
      rmSync(envFile, { force: true });
    }
  }, 60_000);

  test("F14 regression: D passes when ~/.pi/agent/models.json is ABSENT — production AC5 says absence is an empty registry", async () => {
    // MEASURED live 2026-08-25 (gate qds-20260825-0250b0): the box image's pi
    // (0.84.2) never writes ~/.pi/agent/models.json — the registry lives in
    // pi's own store/LLM integration and models-store.json is `{}`. Production
    // readCustomRegistry treats a MISSING file as an EMPTY custom registry
    // priced by the bundled catalog (validate.ts AC5), so D failing on absence
    // is STRICTER than the code it guards. The contract now: absent ⇒ D still
    // passes on the strength of the provider usage.cost proof, naming why; a
    // PRESENT file keeps the full four-key scan (F11 regression test above).
    const binDir = join(rosterDir, "f14-shim-bin");
    installCurlShim(binDir); // no model log needed — C/D shapes only
    const envFile = join(rosterDir, "f14-env");
    writeFileSync(envFile, "OPENROUTER_API_KEY=sk-test-f140000000000000000000\n", { mode: 0o600 });
    const homeDir = join(rosterDir, "f14-home");
    mkdirSync(homeDir, { recursive: true }); // deliberately NO .pi/agent/models.json
    try {
      const proc = Bun.spawn({
        cmd: ["/bin/sh", ASSERTIONS_SCRIPT, writeShimRoster(rosterDir), envFile, "deepseek/deepseek-v3.2"],
        env: shimEnv(binDir, homeDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const parsed = stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { item: string; ok: boolean; note: string });
      const d = parsed.find((r) => r.item === "D");
      expect(d?.ok).toBe(true);
      expect(d?.note).toMatch(/custom registry absent/);
      expect(parsed.find((r) => r.item === "E")?.ok).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("DF2.10 AC2: the F14 absence tolerance is VERSION-CONDITIONAL — an unreviewed pi series refuses D", async () => {
    // The arm above tolerates a missing models.json. DF2.10 owns PI_VERSION, so
    // that tolerance is a claim about a SPECIFIC pi series somebody verified —
    // not a property of pi forever. This is the arm that makes it conditional:
    // bump the pinned pi without revisiting `PI_REVIEWED_SERIES` in
    // assertions-in-box.sh and the mismatch IS the refusal, rather than an
    // unreviewed runtime silently inheriting a tolerance nobody re-checked.
    //
    // Without this test the re-aim is indistinguishable from the unconditional
    // tolerance it replaced: the test above passes under BOTH implementations.
    const binDir = join(rosterDir, "ac2-shim-bin");
    installCurlShim(binDir);
    // Overwrite the shim's pi with one reporting a series nobody reviewed —
    // DERIVED one minor above the pin, so this stays "unreviewed" across bumps.
    writeFileSync(
      join(binDir, "pi"),
      `#!/bin/sh\nif [ "$1" = --version ]; then echo "${UNREVIEWED_PI_SERIES}.0"; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const envFile = join(rosterDir, "ac2-env");
    writeFileSync(envFile, "OPENROUTER_API_KEY=sk-test-ac20000000000000000000\n", { mode: 0o600 });
    const homeDir = join(rosterDir, "ac2-home");
    mkdirSync(homeDir, { recursive: true }); // same absent models.json as above
    try {
      const proc = Bun.spawn({
        cmd: ["/bin/sh", ASSERTIONS_SCRIPT, writeShimRoster(rosterDir), envFile, "deepseek/deepseek-v3.2"],
        env: shimEnv(binDir, homeDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const parsed = stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        // dp:ok the script's contract is one JSON object per line; a malformed
        // line SHOULD throw and fail this test rather than be tolerated.
        .map((l) => JSON.parse(l) as { item: string; ok: boolean; note: string }); /* dp:ok one JSON object per line is the script contract; malformed SHOULD fail the test */
      const d = parsed.find((r) => r.item === "D");
      expect(d?.ok).toBe(false);
      expect(d?.note).toMatch(/UNREVIEWED/);
      expect(d?.note).toContain(UNREVIEWED_PI_SERIES); // names the series it refused
      expect(exitCode).toBe(3); // D's designed exit — a controlled stop, not a crash
      // The refusal must NOT read as the tolerated absence: the pass-matcher in
      // the script greps for "custom registry absent", so a refusal wording
      // containing that phrase would be silently accepted.
      expect(d?.note).not.toMatch(/custom registry absent/);
      // INV-2: the comparison is pure string work over values already on the
      // box, so it is hoisted ABOVE C. A refusal emits ONLY the D line — no C
      // line at all — because it costs neither C's live pings nor D's own paid
      // provider call. The refusal used to run after both, burning real spend on
      // every box in the fleet before saying no.
      expect(parsed.map((r) => r.item)).toEqual(["D"]);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("DF2.10: a pi that prints an update BANNER is read on its installed version, not the advertised one", async () => {
    // The version extraction prefers an exact-LINE match (`grep -xE`) over the
    // first semver-shaped token (`grep -oE`) for one measured reason: pi's
    // update banner ("A new version X is available") puts a HIGHER version
    // first, and a token match would report THAT as the installed series —
    // refusing D on every box in the fleet as a phantom pin bump, on a runtime
    // that never moved. Every other pi double here prints a bare version on a
    // line of its own or nothing at all, so deleting the exact-line pass leaves
    // the AC2, D7 and F14 arms all green and breaks only real boxes.
    const binDir = join(rosterDir, "banner-shim-bin");
    installCurlShim(binDir);
    writeFileSync(
      join(binDir, "pi"),
      // Banner FIRST and semver-shaped, exactly as the token matcher would take
      // it; the real version follows on a line of its own, as the factory image
      // measured it.
      `#!/bin/sh\nif [ "$1" = --version ]; then\n  echo "A new version ${UNREVIEWED_PI_SERIES}.0 is available (you have ${PI_VERSION})"\n  echo "${PI_VERSION}"\nfi\nexit 0\n`,
      { mode: 0o755 },
    );
    const envFile = join(rosterDir, "banner-env");
    writeFileSync(envFile, "OPENROUTER_API_KEY=sk-test-banner000000000000000\n", { mode: 0o600 });
    const homeDir = join(rosterDir, "banner-home");
    mkdirSync(homeDir, { recursive: true }); // absent models.json — the tolerance's arm
    try {
      const proc = Bun.spawn({
        cmd: ["/bin/sh", ASSERTIONS_SCRIPT, writeShimRoster(rosterDir), envFile, "deepseek/deepseek-v3.2"],
        env: shimEnv(binDir, homeDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const parsed = stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { item: string; ok: boolean; note: string }); /* dp:ok one JSON object per line is the script contract; malformed SHOULD fail the test */
      const d = parsed.find((r) => r.item === "D");
      // The installed series IS the reviewed one, so the absence tolerance is
      // granted and the gate runs to completion — the banner's version was
      // never the box's.
      expect(d?.ok).toBe(true);
      expect(d?.note).toMatch(/custom registry absent/);
      expect(d?.note).not.toMatch(/UNREVIEWED/);
      expect(d?.note).not.toContain(UNREVIEWED_PI_SERIES);
      expect(exitCode).toBe(0);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("DF2.10 D7: a pi that cannot report a version refuses D for THAT reason, not a phantom pin bump", async () => {
    // Gate B's `command -v pi` passing does not imply `pi --version` works. When
    // it prints nothing parseable, blaming a PI_VERSION bump states a cause the
    // evidence contradicts — and sends the operator to the Dockerfile for a box
    // whose pi is broken. The arms are DISTINCT: this one names the silence.
    const binDir = join(rosterDir, "d7-shim-bin");
    installCurlShim(binDir);
    // A pi that exists (B passes) and answers --version with nothing at all.
    writeFileSync(join(binDir, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const envFile = join(rosterDir, "d7-env");
    writeFileSync(envFile, "OPENROUTER_API_KEY=sk-test-d700000000000000000000\n", { mode: 0o600 });
    const homeDir = join(rosterDir, "d7-home");
    mkdirSync(homeDir, { recursive: true }); // absent models.json — the tolerance's arm
    try {
      const proc = Bun.spawn({
        cmd: ["/bin/sh", ASSERTIONS_SCRIPT, writeShimRoster(rosterDir), envFile, "deepseek/deepseek-v3.2"],
        env: shimEnv(binDir, homeDir),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      const parsed = stdout
        .trim()
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as { item: string; ok: boolean; note: string }); /* dp:ok one JSON object per line is the script contract; malformed SHOULD fail the test */
      const d = parsed.find((r) => r.item === "D");
      expect(d?.ok).toBe(false);
      expect(d?.note).toMatch(/could not report a pi version/);
      // The other arm's diagnosis must NOT appear: nothing here says the pin moved.
      expect(d?.note).not.toMatch(/UNREVIEWED|PI_VERSION moved/);
      expect(d?.note).not.toMatch(/custom registry absent/);
      expect(exitCode).toBe(3);
      expect(parsed.map((r) => r.item)).toEqual(["D"]); // refused before C's spend
    } finally {
      rmSync(binDir, { recursive: true, force: true });
      rmSync(envFile, { force: true });
      rmSync(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("round 7: env file mode 0644 fails C with 0600/DF2.3 violation note", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-env-mode", originDir, rosterDir);
    // Plant env file with mode 0644 — DF2.3 delivers 0600, drift is a violation
    deliverKey(fake, box.vm, "sk-test-0000000000000000000000", 0o644);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("C");
    expect(result.assertionCode).toBe(ASSERTION_CODE.C);
    const c = result.assertions.find((a) => a.item === "C");
    expect(c?.ok).toBe(false);
    expect(c?.note).toMatch(/0600.*DF2\.3 contract violation/i);
  }, 60_000);

  test("round-6 regression: E rejects negative limit (limit -5) — not positive (round-6)", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-e-neg-limit", originDir, rosterDir);
    // keyRawBody: the stub prints this verbatim, Python json.load parses -5 as int
    fake.configure(box.vm, { keyRawBody: '{"data":{"limit":-5,"usage":0}}' });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("E");
    expect(result.assertionCode).toBe(4);
    const e = result.assertions.find((a) => a.item === "E");
    expect(e?.ok).toBe(false);
    expect(e?.note).toMatch(/limit.*is not positive/);
  }, 60_000);

  test("round-6 regression: E rejects negative usage (usage -10) — negative (round-6)", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-e-neg-usage", originDir, rosterDir);
    fake.configure(box.vm, { keyRawBody: '{"data":{"limit":100,"usage":-10}}' });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("E");
    expect(result.assertionCode).toBe(4);
    const e = result.assertions.find((a) => a.item === "E");
    expect(e?.ok).toBe(false);
    expect(e?.note).toMatch(/usage.*is negative/);
  }, 60_000);

  test("round-6 regression: D rejects Infinity cost.total — non-finite (round-6)", async () => {
    const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
    const box = await makeBox(fake, driver, "gate-d-inf-cost", originDir, rosterDir);
    // costTotalRaw: the stub emits bare Infinity — Python json.load parses it
    // as float("inf"), which used to pass D's bare `> 0` check (round 6).
    fake.configure(box.vm, { pi: { mode: "table", costTotal: 0, costTotalRaw: "Infinity" } });
    deliverKey(fake, box.vm);

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("D");
    expect(result.assertionCode).toBe(3);
    const d = result.assertions.find((a) => a.item === "D");
    expect(d?.ok).toBe(false);
    expect(d?.note).toMatch(/cost\.total = inf/);
  }, 60_000);

  test("round-5 regression: no time left at C/D/E — launch refused, never a clamped 1 ms spend past the deadline", async () => {
    // MUST STAY LAST IN THIS FILE: bun's setSystemTime is FROZEN (probed:
    // 0 ms advance across real sleeps) and is not unmocked by mock.restore(),
    // only reset between test FILES — every test after this one would share a
    // frozen clock, breaking the real-time budget tests above.
    //
    // Advancing exactly gateTimeoutMs across the TAXED_CALLS pre-C/D/E seam
    // calls pins remaining = 0 at the C/D/E check: the launch must be REFUSED
    // with the named exhaustion notes and the spend script never reaches the
    // seam.
    //
    // The clock is frozen, but `budgetFree()` is handed to the fake as a REAL
    // deadline it enforces with a SIGKILL — so a schedule this test advances too
    // slowly starves the earlier calls and a loaded host loses one of them to
    // the kill, failing on A instead of C. FROZEN_STEP_MS is what buys those
    // calls their real time; the virtual arithmetic is unchanged by its value.
    // (The guard→budget TOCTOU window itself — microseconds inside
    // assertionsInBox's cached synchronous read — cannot be driven from
    // outside the process; this pins the refusal the late remaining read
    // guarantees, which is the code the round-5 fix changed.)
    const edgeFake = fakeExeDev();
    const gateScriptLaunches: boolean[] = [];
    const frozenRun: FakeCommand = async (argv, o) => {
      const res = await edgeFake.run(argv, o);
      gateScriptLaunches.push(argv.some((a) => a.includes("DF2.2 — setup-gate assertions")));
      setSystemTime(new Date(Date.now() + FROZEN_STEP_MS)); // an exact TAXED_CALLS × FROZEN_STEP_MS schedule
      return res;
    };
    const frozenDriver = new ExeDevDriver({ run: frozenRun });
    try {
      const sha = (await runLocal(["git", "-C", originDir, "rev-parse", "HEAD"])).trim();
      const box = await makeBox(edgeFake, frozenDriver, "gate-cde-expired", originDir, rosterDir);
      deliverKey(edgeFake, box.vm);

      const result = await frozenDriver.setup(
        box.vm,
        gateOpts(box, { commitSha: sha, gateTimeoutMs: FROZEN_STEP_MS * TAXED_CALLS }), // → exactly 0 ms left at C/D/E
      );
      expect(result.ready).toBe(false);
      expect(result.failedItem).toBe("C");
      expect(result.assertionCode).toBe(2);
      for (const item of ["C", "D", "E"] as const) {
        expect(result.assertions.find((a) => a.item === item)?.note).toMatch(
          /budget exhausted before C\/D\/E ran/,
        );
      }
      expect(gateScriptLaunches.some((launched) => launched)).toBe(false); // spend script NEVER launched
    } finally {
      // RESTORE THE CLOCK. bun's frozen time is reset between test FILES, not
      // between tests, so leaving it frozen leaked it out of this test and into
      // every `describe` block below — where `budgetFree()` returned the full
      // `gateTimeoutMs` on every call and a deadline could never expire. Those
      // tests then measured a different gate than `bun test -t` running them
      // alone. "MUST STAY LAST" above kept the file honest by ordering; this
      // keeps it honest by construction.
      setSystemTime();
      edgeFake.cleanup();
    }
  }, 60_000);
});

// ─── D9/D10/D14 (review round 11): typed roster refusals, requestId fallback,
// actionTimeoutMs validation — the gate's own input contract, driven directly ──

describe("setup gate — input contract (D9/D10/D14)", () => {
  const fake = fakeExeDev();
  afterAll(() => fake.cleanup(), HOOK_TIMEOUT_MS);

  function minimalOpts(patch: Partial<Parameters<typeof setupGate>[2]> = {}): Parameters<typeof setupGate>[2] {
    // A roster-bearing option bag; the fs errors below fire BEFORE any probe
    // runs, so no box is ever created and nothing here touches the substrate.
    return {
      runId: "gate-input-run",
      rosterPath: join(mkdtempSync(join(tmpdir(), "qds-sg-input-")), "roster.yaml"),
      commitSha: "a".repeat(40),
      ...patch,
    } as Parameters<typeof setupGate>[2];
  }

  // D9: every fs failure below parse is TYPED `RosterError` with the errno named
  // — a bare ENOENT/EACCES out of statSync/readFileSync used to escape as an
  // unclassified crash on a brief-steered path. Three distinct arms, each
  // falsifying one hypothesis about how the read fails.
  test("D9: an ENOENT roster path refuses as a typed RosterError naming the errno", async () => {
    let err: unknown;
    try {
      await setupGate(new ExeDevDriver({ run: fake.run }), "gate-input-vm", minimalOpts());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RosterError);
    expect(String((err as Error).message)).toContain("ENOENT");
  });

  test("D9: a roster DIRECTORY refuses as 'not a regular file', not a read error", async () => {
    const dirRoster = mkdtempSync(join(tmpdir(), "qds-sg-dirroster-"));
    let err: unknown;
    try {
      await setupGate(new ExeDevDriver({ run: fake.run }), "gate-input-vm", minimalOpts({ rosterPath: dirRoster }));
    } catch (e) {
      err = e;
    } finally {
      rmSync(dirRoster, { recursive: true, force: true });
    }
    expect(err).toBeInstanceOf(RosterError);
    expect(String((err as Error).message)).toContain("not a regular file");
    expect(String((err as Error).message)).toContain("a directory");
  });

  test("D10: a non-string requestId falls back to the driver's id instead of crashing the gate", async () => {
    // The documented fallback ({"requestId": 42} from a JSON-built bag), pinned
    // at the sink: `.trim()` used to TypeError on it, turning a missing id into
    // an untyped gate crash BEFORE any assertion ran. The box must EXIST (the
    // fallback sits before the first probe; on a missing box the sentinel clear
    // throws first) and the roster must PARSE, so execution reaches gate_A and
    // its structured emission — which must carry the DRIVER's id, not a crash,
    // not "42", not undefined.
    const watched = new ExeDevDriver({ run: fake.run, requestId: "driver-side-id" });
    await watched.create("d10-vm-20260827-a1b2c3");
    // A PARSEABLE roster: the gate parses it host-side after resolving requestId
    // and before the first probe, so the valid fixture proves execution reached
    // gate_A through the fallback (the parseable-roster precondition is the
    // whole difference between "fallback held" and "roster refused first").
    const d10Roster = join(mkdtempSync(join(tmpdir(), "qds-sg-d10-")), "roster.yaml");
    writeFileSync(d10Roster, ROSTER, { mode: 0o600 });
    const seen: string[] = [];
    const restore = setLogSink((e) => {
      if (String((e as { operation?: string }).operation ?? "").startsWith("exedev.gate")) {
        seen.push(String((e as { requestId?: string }).requestId));
      }
    });
    try {
      await setupGate(watched, "d10-vm-20260827-a1b2c3", minimalOpts({ requestId: 42 as unknown as string, rosterPath: d10Roster }));
      // ready:false is fine — item A/C verdicts are not what this test measures;
      // reaching ANY result proves the gate ran past the id resolution.
    } catch {
      // …and so does any probe-level failure AFTER the first emission.
    } finally {
      restore();
      rmSync(d10Roster, { force: true });
    }
    expect(seen.length).toBeGreaterThan(0); // the gate really emitted
    expect(seen.every((id) => id === "driver-side-id")).toBe(true);
    // 60 s like every other test that provisions a fake box: this one creates a
    // box and runs the gate to its first emission, which did not fit bun's 5 s
    // default on a loaded host (measured failing at 5 018 ms). That measurement
    // was taken while the frozen clock of the round-5 test above still leaked
    // into this block; with the clock restored the whole describe runs in
    // ~690 ms in isolation, so the budget is no longer load-bearing — kept
    // anyway, as the ceiling every other box-provisioning test in this file
    // carries. A green run cannot prove a ceiling unnecessary, only unhit.
  }, 60_000);

  test("D14: actionTimeoutMs of 0 / negative / NaN refuses with action-timeout-invalid", async () => {
    // The store lives in a FRESH tmpdir per call: provisionAdmittedRun writes the
    // record (INV-1) before it would touch the driver, and the timeout guard runs
    // BEFORE that — so an EEXIST here would mean the guard moved or was lost.
    const storeRoot = mkdtempSync(join(tmpdir(), "qds-sg-timeout-"));
    try {
      for (const bad of [0, -5, Number.NaN]) {
        let err: unknown;
        try {
          await provisionAdmittedRun(
            new ExeDevDriver({ run: fake.run }),
            new RunRecordStore(join(storeRoot, `runs-${String(bad).replace(".", "")}`)),
            {
              runId: "timeout-invalid-run",
              budget: {
                repoSlug: "qds/demo",
                issueId: "42",
                capMicroUsd: 1,
                spentMicroUsd: 0,
                reservedMicroUsd: 0,
                admittedCeilingMicroUsd: 1,
              },
              actionTimeoutMs: bad,
            },
          );
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(ProvisionRefusedError);
        expect((err as ProvisionRefusedError).code).toBe("action-timeout-invalid");
        // The remediation must not send an operator hunting a provider outage
        // that was a caller bug.
        expect((err as ProvisionRefusedError).remediation).toContain("omit actionTimeoutMs");
        // EACCES-on-box-hours-remediation aside, nothing else happened: no box
        // (the fake's boxes dir never materializes without create), and this
        // refusal precedes even the INV-1 record write.
      }
    } finally {
      rmSync(storeRoot, { recursive: true, force: true });
    }
  });
});
