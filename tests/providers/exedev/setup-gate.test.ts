/**
 * DF2.2 — the five-assertion setup gate.
 *
 * Every test drives the PRODUCTION gate through the production driver; only
 * the substrate is faked, and faked by content (the stubs print what a broken
 * box prints), never by exit status. The in-box script
 * (`src/providers/exedev/assertions-in-box.sh`) runs for real on the host
 * inside the fake box, so C/D/E are exercised end to end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExeDevDriver } from "../../../src/providers/exedev/driver.ts";
import { ASSERTION_CODE } from "../../../src/providers/exedev/setup-gate.ts";
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

/** A local git origin + the roster file + a fill'd box — the gate's preconditions. */
interface Box {
  vm: string;
  rosterPath: string;
}

/** DF2.3 already delivered the key BEFORE setup (Infra ordering). Planted
 *  HOST-side so the key never appears in the seam's argv corpus — which is
 *  exactly what the INV-4 leak scan asserts against. */
function deliverKey(fake: FakeExeDev, vm: string, key = "sk-test-0000000000000000000000"): void {
  writeFileSync(join(fake.homeDir(vm), "app", ".env"), `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
}

/** The full create → fill chain on the fake substrate; returns the pinned SHA. */
async function makeBox(
  fake: FakeExeDev,
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
  });

  afterAll(() => {
    fake.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  });

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

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(true);
    expect(result.failedItem).toBeUndefined();
    expect(result.assertionCode).toBeUndefined();
    expect(result.assertions.map((a) => a.item)).toEqual(["A", "B", "C", "D", "E"]);
    for (const a of result.assertions) {
      expect(a.ok).toBe(true);
      expect(a.note.length).toBeGreaterThan(0);
    }
    expect(result.assertions[0]?.note).toMatch(/^A: HEAD [0-9a-f]{7,}, porcelain empty$/);
    expect(result.assertions[3]?.note).toMatch(/^D: pi cost\.total [0-9.e-]+ > 0; \d+\/\d+ models priced$/);
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

    const result = await driver.setup(box.vm, gateOpts(box, { commitSha: sha }));
    expect(result.ready).toBe(false);
    expect(result.failedItem).toBe("A");
    expect(result.assertions[0]?.note).toMatch(/porcelain/);
    // INV-2: A failed, so NOTHING that spends ran — B/C/D/E absent.
    expect(result.assertions.map((a) => a.item)).toEqual(["A"]);
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
    ).rejects.toThrow(/must each be >= 1 ms/i);
    await expect(
      driver.setup(box.vm, gateOpts(box, { commitSha: sha, gateTimeoutMs: 0 })),
    ).rejects.toThrow(/must each be >= 1 ms/i);
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
});

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
    expect(mod.DEFAULT_ENV_FILE).toBe("/home/agent/app/.env");
  });
});
