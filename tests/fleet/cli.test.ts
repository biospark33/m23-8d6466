/**
 * CLI tests (Story DF3.1): scripts/fleet.ts run() contract + the MANDATORY
 * e2e demo (DoD): dispatch → status → teardown against the fake driver,
 * capturing the three outputs for the Dev Agent Record.
 *
 * Also covers (DoD): --help renders from the registry (no second list),
 * bidirectional verb coverage, malformed briefs via stdin → exit 2 with
 * zero provisioning, unknown runId → exit 4 mutating nothing, the 64 KiB cap
 * on BOTH sides of its boundary, the FleetError→exit-code table (2/3/4/5), the
 * registry-backed flag grammar, and the shared per-run lock the teardown verb
 * takes (scripts/lib/run-lock.ts — the same one sandbox-teardown holds).
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../../scripts/fleet.ts";
import { listVerbs, renderHelp } from "../../src/fleet/verbs.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import type { FleetDeps, } from "../../scripts/fleet.ts";
import type { LedgerLike } from "../../src/fleet/dispatch.ts";
import { goodLedger } from "./helpers.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "df3-1-cli-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

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
const EXPECTED_VERBS = ["dispatch", "status", "harvest", "teardown"] as const;

/** Exit code for `fleet <verb>` with no positional and an injected driver. */
const BARE_VERB_EXIT: Record<(typeof EXPECTED_VERBS)[number], number> = {
  dispatch: 2, // brief read, then refused as invalid JSON — never unknown-verb
  status: 0, // no runs is a state, not an error (AC4)
  harvest: 2, // missing <run-id>
  teardown: 2, // missing <run-id>
};

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
    manifestPath,
    repoUrl: "https://github.com/owner/repo",
  });
}

/** The DF2.8 refused decision shape — the CLI must render it as exit 5. */
function overBudgetLedger(): LedgerLike {
  return {
    config: { defaultCapMicroUsd: 10_000_000, perIssueOverrides: {} },
    admitIssue: () => ({
      admitted: false as const,
      status: "over-budget" as const,
      reason: "spend-cap-exceeded" as const,
      capMicroUsd: 10_000_000,
      spentMicroUsd: 12_000_000,
      reservedMicroUsd: 0,
      unpricedRows: 0,
    }),
    close: () => {},
  };
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
  let captured: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpRoot, "cli-"));
    boxesDir = join(dir, "boxes");
    runsDir = join(dir, "runs");
    captured = [];
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
    captured.push(s);
  };

  const text = (): string => captured.join("");

  // ─── --help renders from the registry (AC6) ────────────────────────────────

  test("--help renders the registry's four verbs and their declared flags", async () => {
    const code = await run(["--help"], out, deps(""));
    expect(code).toBe(0);
    const helpText = text();
    // The registry is the contract; pinning it to a literal is what makes the
    // assertions below fail when a verb is dropped instead of shrinking with it.
    expect(listVerbs().map((v) => v.verb)).toEqual([...EXPECTED_VERBS]);
    expect(helpText.startsWith("Usage: fleet <verb> [options]")).toBeTrue();
    expect(helpText.endsWith("\n")).toBeTrue();
    for (const verb of EXPECTED_VERBS) expect(helpText).toContain(verb);
    for (const flag of ["--driver", "--brief", "--dir", "--port", "--no-harvest", "--help"]) {
      expect(helpText).toContain(flag);
    }
    expect(helpText).toContain("Exit codes:");
    // No second list: the text IS the registry rendering, byte for byte.
    expect(helpText).toBe(`${renderHelp(listVerbs())}\n`);
  });

  test("every documented help path exits 0 and prints usage", async () => {
    for (const argv of [["--help"], ["-h"], ["help"], ["dispatch", "--help"], ["status", "-h"], ["teardown", "--help"]]) {
      captured.length = 0;
      const code = await run(argv, out, deps(""));
      expect(code).toBe(0);
      expect(text()).toContain("Usage: fleet <verb> [options]");
    }
  });

  test("with no repoRoot injected the containment root defaults to the process cwd", async () => {
    // Every other case injects `repoRoot`, so without this one a default that
    // regressed to "no containment at all" would keep the whole file green
    // while shipping the traversal INV-1 exists to stop. The manifest here sits
    // in the case's tmpdir — outside the repo the CLI is actually run from — so
    // the default MUST refuse it.
    const { repoRoot: _omitted, ...noRoot } = deps(validBriefJson(dir));
    const code = await run(["dispatch", "--driver", "fake"], out, noRoot);
    expect(code).toBe(2);
    expect(text()).toContain("manifest-rejected");
    // Named so the refusal is provably the containment check and not a schema
    // complaint about the same brief.
    expect(text()).toContain("outside the run root");
    expect(readdirSync(runsDir)).toHaveLength(0);
    // `boxesDir` itself is created by FakeDriver's constructor, so its
    // existence proves nothing — its emptiness is the assertion that matters.
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  test("no verb → exit 2 usage (a bare `fleet` is a mistyped invocation, not a help request)", async () => {
    const code = await run([], out, deps(""));
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
      captured.length = 0;
      const code = await run([verb], out, deps(""));
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
      captured.length = 0;
      const d = deps("");
      const code = await run([word], out, d);
      expect({ word, code }).toEqual({ word, code: 2 });
      const envelope = JSON.parse(captured[0] as string) as { code: string; message: string };
      expect(envelope.code).toBe("unknown-verb");
      expect(envelope.message).toBe(`unknown verb ${JSON.stringify(word)}`);
      expect(readdirSync(runsDir)).toHaveLength(0);
      expect(readdirSync(boxesDir)).toHaveLength(0);
    }
  });

  test("no verb is wired into the dispatch switch without a registry entry", async () => {
    // The other direction of AC6 parity, and the only way to see it: the
    // registry check runs BEFORE the switch, so an unregistered arm is
    // unreachable at runtime and no black-box probe can find it. Read the arms.
    const source = readFileSync(join(import.meta.dir, "../../scripts/fleet.ts"), "utf8");
    const wired = [...source.matchAll(/verb === "([a-z-]+)"/g)].map((m) => m[1] as string);
    expect(wired.length).toBeGreaterThan(0);
    const registry = listVerbs().map((v) => v.verb);
    for (const verb of wired) expect(registry).toContain(verb);
  });

  test("the registry owns the per-verb flag grammar: `status --brief x` is refused, not ignored", async () => {
    const code = await run(["status", "--driver", "fake", "--brief", "x"], out, deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("status does not take --brief");
    // The remediation lists what status DOES take.
    expect(text()).toContain("--driver");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--no-harvest is a teardown flag only", async () => {
    const code = await run(["dispatch", "--driver", "fake", "--no-harvest"], out, deps(""));
    expect(code).toBe(2);
    expect(text()).toContain("dispatch does not take --no-harvest");
  });

  // ─── --driver is required on every verb (no silent fake) ───────────────────

  test("every verb refuses without --driver (exit 2), before reading a brief or a record", async () => {
    for (const argv of [["dispatch"], ["status"], ["harvest", "qds-20260101-abcdef"], ["teardown", "qds-20260101-abcdef"]]) {
      captured.length = 0;
      const code = await run(argv, out, {});
      expect({ argv, code }).toEqual({ argv, code: 2 });
      expect(text()).toContain(`${argv[0] as string} requires --driver <name>`);
      // Refused before provisioning: no default runs dir, no default boxes dir.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
      expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
    }
  });

  test("an unknown --driver refuses — it never falls back to the fake driver", async () => {
    // The flag is inert in every test that injects `deps.driver`; this is the
    // one path where the CLI actually resolves it.
    const code = await run(["status", "--driver", "no-such-driver"], out, {});
    expect(code).toBe(1);
    expect(text()).toContain("unknown provider driver: no-such-driver");
    expect(text()).toContain("registered:");
    expect(existsSync(join(dir, ".sandbox", "fake-boxes"))).toBeFalse();
  });

  // ─── malformed brief → exit 2, zero provisioning (INV-2) ───────────────────

  test("unknown brief field → exit 2 naming the field, zero records, zero boxes", async () => {
    const bad = JSON.stringify({ ...JSON.parse(validBriefJson(dir)), extraField: 1 });
    const code = await run(["dispatch", "--driver", "fake"], out, deps(bad));
    expect(code).toBe(2);
    expect(text()).toContain("extraField");
    expect(readdirSync(runsDir)).toHaveLength(0);
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  test("brief over 64 KiB → exit 2 brief-too-large naming the cap", async () => {
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"x".repeat(70_000)}`);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await run(["dispatch", "--driver", "fake"], out, deps(big));
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
    const code = await run(["dispatch", "--driver", "fake"], out, deps(padded));
    expect(text()).not.toContain("brief-too-large");
    expect(code).toBe(0);
  });

  test("the cap counts BYTES, not UTF-16 code units", async () => {
    // 40 000 two-byte characters: 80 000 bytes, but `.length` sees ~40 000 and
    // would wave the brief through.
    const big = validBriefJson(dir).replace("owner/repo", `owner/${"é".repeat(40_000)}`);
    expect(big.length).toBeLessThan(MAX_BRIEF_BYTES);
    expect(Buffer.byteLength(big, "utf8")).toBeGreaterThan(MAX_BRIEF_BYTES);
    const code = await run(["dispatch", "--driver", "fake"], out, deps(big));
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(readdirSync(runsDir)).toHaveLength(0);
  });

  test("--brief <path> over 64 KiB → exit 2 brief-too-large, never invalid-brief", async () => {
    // Path-sourced oversize is refused by readBrief's stat BEFORE any JSON
    // parse — the catch must re-emit the FleetError, not relabel it.
    const bigPath = join(dir, "big-brief.json");
    writeFileSync(bigPath, "x".repeat(MAX_BRIEF_BYTES + 1));
    const code = await run(["dispatch", "--driver", "fake", "--brief", bigPath], out, {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-too-large");
    expect(text()).not.toContain("invalid-brief");
  });

  test("--brief /dev/zero is refused as not a regular file, never read unbounded", async () => {
    // A character device reports size 0: the cap would be vacuous and the read
    // would never end.
    const code = await run(["dispatch", "--driver", "fake", "--brief", "/dev/zero"], out, {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("not a regular file");
  });

  test("--brief <missing path> names the errno, not a JSON error", async () => {
    const code = await run(["dispatch", "--driver", "fake", "--brief", join(dir, "nope.json")], out, {});
    expect(code).toBe(2);
    expect(text()).toContain("brief-unreadable");
    expect(text()).toContain("ENOENT");
    expect(text()).not.toContain("invalid-brief");
  });

  test("invalid JSON brief → exit 2", async () => {
    const code = await run(["dispatch", "--driver", "fake"], out, deps("{not json"));
    expect(code).toBe(2);
    expect(text()).toContain("invalid-brief");
  });

  test("`yes | fleet dispatch` hits brief-too-large immediately instead of buffering to OOM", async () => {
    // The one path that must refuse AS IT STREAMS; an in-process test cannot
    // see it, because `deps.readBrief` replaces the stdin reader entirely.
    const proc = Bun.spawn(
      ["sh", "-c", `yes | bun ${JSON.stringify(join(import.meta.dir, "../../scripts/fleet.ts"))} dispatch --driver fake`],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code).toBe(2);
      expect(stderr).toContain("brief-too-large");
      expect(stdout).toBe(""); // stdout carries output only
      // Refused before provisioning: nothing was created under the cwd.
      expect(existsSync(join(dir, ".sandbox", "runs"))).toBeFalse();
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  // ─── --port grammar and the ack's httpsUrl ─────────────────────────────────

  test("--port must be a TCP port → exit 2, nothing provisioned", async () => {
    for (const bad of ["abc", "0", "65536", "8080.5", "-1"]) {
      captured.length = 0;
      const code = await run(["dispatch", "--driver", "fake", "--port", bad], out, deps(validBriefJson(dir)));
      expect({ bad, code }).toEqual({ bad, code: 2 });
      expect(text()).toContain("is not a TCP port");
      expect(readdirSync(runsDir)).toHaveLength(0);
      expect(readdirSync(boxesDir)).toHaveLength(0);
    }
    // An empty value is refused by the flag parser, one step earlier — same
    // exit, different (and more accurate) message.
    captured.length = 0;
    expect(await run(["dispatch", "--driver", "fake", "--port", ""], out, deps(validBriefJson(dir)))).toBe(2);
    expect(text()).toContain("--port requires a non-empty value");
  });

  test("--port <n> exposes the box and the ack carries its httpsUrl", async () => {
    const shared = deps(validBriefJson(dir));
    const code = await run(["dispatch", "--driver", "fake", "--port", "8080"], out, shared);
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
    const code = await run(["dispatch", "--driver", "fake"], out, shared);
    expect(code).toBe(3);
    const envelope = JSON.parse(captured.find((l) => l.includes("setup-gate-failed")) as string) as {
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
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), ledgerFactory: () => overBudgetLedger() };
    const code = await run(["dispatch", "--driver", "fake"], out, shared);
    expect(code).toBe(5);
    const envelope = JSON.parse(captured.find((l) => l.includes("budget-exceeded")) as string) as {
      code: string;
      capMicroUsd: number;
      spentMicroUsd: number;
    };
    expect(envelope.code).toBe("budget-exceeded");
    expect(envelope.capMicroUsd).toBe(10_000_000);
    expect(envelope.spentMicroUsd).toBe(12_000_000);
    expect(readdirSync(runsDir)).toHaveLength(0);
    expect(readdirSync(boxesDir)).toHaveLength(0);
  });

  // ─── status unknown run → exit 4, mutates nothing (AC4) ────────────────────

  test("status <unknown-runId> → exit 4 run-not-found, no driver list call", async () => {
    const driver = new FakeDriver(boxesDir);
    // Bind BEFORE overwriting: reading driver.list inside the mock after the
    // reassignment would recurse into the mock itself.
    const originalList = driver.list.bind(driver);
    const listSpy = mock(() => originalList());
    driver.list = listSpy;
    const d = deps(validBriefJson(dir));
    (d as { driver?: FakeDriver }).driver = driver;
    const code = await run(["status", "qds-19990101-000000"], out, d);
    expect(code).toBe(4);
    expect(text()).toContain("run-not-found");
    expect(listSpy).not.toHaveBeenCalled();
  });

  test("teardown <unknown-runId> → exit 4 run-not-found", async () => {
    const code = await run(["teardown", "qds-19990101-000000"], out, deps(validBriefJson(dir)));
    expect(code).toBe(4);
    expect(text()).toContain("run-not-found");
    // Nothing was left behind for the next invocation to trip over.
    expect(readdirSync(runsDir).filter((f) => f.endsWith(".lock"))).toHaveLength(0);
  });

  // ─── the shared per-run lock (scripts/lib/run-lock.ts) on the teardown verb ─

  test("teardown takes the shared run lock: a held lock refuses and mutates nothing", async () => {
    const shared = deps(validBriefJson(dir));
    const store = shared.store as RunRecordStore;
    const driver = shared.driver as FakeDriver;
    const dispatchCode = await run(["dispatch", "--driver", "fake"], out, shared);
    expect(dispatchCode).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    // A concurrent teardown's lock. If `fleet teardown` stopped acquiring it,
    // two invocations would double-destroy the box and double-write the spend.
    const lock = join(runsDir, `${runId}.lock`);
    const holder = process.pid + 1;
    writeFileSync(lock, `${holder} ${new Date(Date.now() - 4_000).toISOString()} feedface\n`, { flag: "wx" });

    captured.length = 0;
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, runId], out, shared);

    expect(code).toBe(1);
    expect(text()).toContain("run-locked");
    expect(text()).toContain("another invocation holds"); // fleet's holder wording
    expect(text()).toContain(`pid ${holder}`);
    // The refused invocation neither tore down nor stole the holder's lock.
    expect(readFileSync(lock, "utf8")).toContain("feedface");
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await driver.list()).map((vm) => vm.name)).toContain(vmName);
    rmSync(lock);
  });

  test("teardown releases the run lock when the teardown itself fails", async () => {
    const base = new FakeDriver(boxesDir);
    const shared: Partial<FleetDeps> = { ...deps(validBriefJson(dir)), driver: base };
    const store = shared.store as RunRecordStore;
    expect(await run(["dispatch", "--driver", "fake"], out, shared)).toBe(0);
    const { runId, vmName } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as {
      runId: string;
      vmName: string;
    };

    captured.length = 0;
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, runId], out, {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });

    expect(code).toBe(1);
    expect(text()).toContain("destroy-unconfirmed");
    // A lock left on disk here makes the run permanently un-teardownable while
    // its box keeps billing.
    expect(existsSync(join(runsDir, `${runId}.lock`))).toBeFalse();
    expect(store.get(runId).closedAt).toBeUndefined();
    expect((await base.list()).map((vm) => vm.name)).toContain(vmName);
  });

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
    // A committed, valid manifest INSIDE the repo: dispatch's containment root
    // is the cwd, and this case must not move the cwd to satisfy it.
    const brief = JSON.stringify({
      repoSlug: "owner/repo",
      issueId: 4242,
      commitSha: "c".repeat(40),
      manifestPath: join(import.meta.dir, "../phase-engine/fixtures/pipeline.qds-factory.json"),
      repoUrl: "https://github.com/owner/repo",
    });
    const shared: Partial<FleetDeps> = {
      driver: new FakeDriver(boxesDir),
      keyApi: new FakeKeyApi(),
      readBrief: async () => brief,
      // store and ledgerFactory are deliberately NOT injected: --dir has to
      // build both, and injecting either would hide the thing under test.
    };
    const cwdLedger = join(process.cwd(), ".sandbox", "cost-ledger.db");
    const before = existsSync(cwdLedger) ? statSync(cwdLedger).mtimeMs : null;

    expect(await run(["dispatch", "--driver", "fake", "--dir", runs], out, shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };
    expect(existsSync(join(sandbox, "cost-ledger.db"))).toBeTrue();
    expect(existsSync(join(runs, `${runId}.json`))).toBeTrue();

    captured.length = 0;
    expect(await run(["teardown", "--driver", "fake", "--dir", runs, runId], out, shared)).toBe(0);
    expect(text()).toContain(`torn down: ${runId}`);
    // Box hours priced into the --dir ledger, and nothing written under the cwd.
    expect(existsSync(join(sandbox, "cost-ledger.db"))).toBeTrue();
    expect(existsSync(cwdLedger) ? statSync(cwdLedger).mtimeMs : null).toBe(before);
    expect(existsSync(join(dir, ".sandbox", "cost-ledger.db"))).toBeFalse();
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
    const shared: Partial<FleetDeps> = {
      driver,
      keyApi,
      store,
      ledgerFactory: () => goodLedger(),
      readBrief: async () => brief,
      repoRoot: dir,
    };

    // 1. dispatch — prints the ack, exits 0
    const dispatchCode = await run(["dispatch", "--driver", "fake"], out, shared);
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

    // 2. status — lists the run live
    captured.length = 0;
    const statusCode = await run(["status", "--driver", "fake"], out, shared);
    expect(statusCode).toBe(0);
    const rowLine = captured.find((l) => l.includes(ack.runId)) as string;
    expect(rowLine).toBeDefined();
    const row = JSON.parse(rowLine) as { runId: string; state: string };
    expect(row.runId).toBe(ack.runId);
    expect(row.state).toBe("live");

    // 3. teardown — destroys the box and closes the record with the spend
    captured.length = 0;
    const teardownCode = await run(["teardown", "--driver", "fake", "--dir", runsDir, ack.runId], out, shared);
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
    captured.length = 0;
    const afterCode = await run(["status", "--driver", "fake", ack.runId], out, shared);
    expect(afterCode).toBe(0);
    const closedRow = JSON.parse(captured[0] as string) as { state: string; boxAlive?: boolean };
    expect(closedRow.state).toBe("closed");
    expect(closedRow.boxAlive).toBeUndefined(); // the box really is gone
  });

  test("e2e: --no-harvest prints the waiver only after the teardown succeeds", async () => {
    const shared = deps(validBriefJson(dir));
    expect(await run(["dispatch", "--driver", "fake"], out, shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    captured.length = 0;
    expect(await run(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], out, shared)).toBe(0);
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
    expect(await run(["dispatch", "--driver", "fake"], out, shared)).toBe(0);
    const { runId } = JSON.parse(captured.find((l) => l.includes("runId")) as string) as { runId: string };

    captured.length = 0;
    const code = await run(["teardown", "--driver", "fake", "--dir", runsDir, "--no-harvest", runId], out, {
      ...shared,
      driver: driverWith(base, {
        destroy: async () => {
          throw new Error("substrate refused the destroy");
        },
      }),
    });
    expect(code).toBe(1);
    expect(text()).toContain("destroy-unconfirmed");
    expect(text()).not.toContain("teardown.harvest_waived");
    expect(text()).not.toContain("torn down:");
  
  });
});
