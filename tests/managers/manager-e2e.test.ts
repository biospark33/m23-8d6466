/**
 * A1 leaf-1.2.2 — the DOD e2e demo (the story's MANDATORY slice): the full
 * fake-journal loop — config → provisioning validation → budget reservations
 * → digest invocation → snapshot with join keys, escalation marks, and both
 * ledger reads — green in CI with zero fork code present.
 *
 * Four legs:
 *  A. provisioning: the config of record validates (AC1's operator-as-user),
 *     then the seam fakes provision the three managers (tokens ×4 per bot,
 *     one budget reservation per bot at its configured ceiling — AC4).
 *  B. the digest: the REAL composeDigest over a journaled fake CLI (exactly
 *     `status --driver exedev` + one `result` per run, nothing else), with
 *     the gateway-spend reader backed by the fakes' budget journal and the
 *     cost-ledger dep backed by fixture rows. A1's truth asserted end to end:
 *     all-fleet-only lines (`botId` absent, `bot_turn_spend_usd` absent —
 *     never null/0), `workKey` in `w:` form, the three escalation marks, and
 *     digest-complete last (AC3/AC5).
 *  C. the CI-green invariant: zero fork/zeropoint markers in the import lines
 *     of the three manager source files (the two src/managers modules plus
 *     scripts/manager-digest.ts — the CLI the src/tests scans do not cover).
 *  D. the real binary: `bun scripts/manager-digest.ts --driver exedev`
 *     spawned on a good config (exit 0, composed) and on an org-owner config
 *     (exit 2, the named `org-owner-refused` error on stderr — AC1's negative
 *     control through the real binary). Fixtures live in a tmpdir; nothing
 *     outside tmp is written — every spawned leg also points QDS_RUNS_DIR at
 *     its own tmpdir, so the CLI's run lock never contends on (or writes to)
 *     the repo's real .sandbox/runs; the fleet entry is pointed at a tmp
 *     fixture through the CLI's QDS_MANAGER_FLEET_ENTRY seam because the live
 *     `fleet status --driver exedev` needs a real provider.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { forkImportOffenders } from "./scan-helpers.ts";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { validateManagerConfig } from "../../src/managers/manager-config.ts";
import {
  composeDigest,
  DIGEST_EXIT,
  PARK_THRESHOLD_MS,
  type CliInvoker,
  type DigestDeps,
} from "../../src/managers/digest-composer.ts";
import type { RunRecord } from "../../src/providers/run-record.ts";
import { acquireRunLock, isAlive, releaseRunLock } from "../../scripts/lib/run-lock.ts";
import { createSeamFakes, PROFILE_TOKEN_NAMES } from "./home-seam-fakes.ts";
import {
  captureInto,
  costView,
  event,
  fakeCli,
  NOW,
  record,
  restoreCaptures,
} from "./fixture-helpers.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const GATEWAY = "https://gateway.a1-e2e.example";

/** The manager config of record fixture — one Home, operator-as-user, three `bot-`-prefixed ceilings. */
const MANAGER_CONFIG = {
  homes: [{ owner: { kind: "user", id: "operator" }, gatewayBaseUrl: GATEWAY }],
  bots: [
    { id: "bot-dev", department: "dev", spendCeilingUsd: 5 },
    { id: "bot-qa", department: "qa", spendCeilingUsd: 6 },
    { id: "bot-maintenance", department: "maintenance", spendCeilingUsd: 7 },
  ],
};

// ─── A. provisioning: config validation + seam fakes ─────────────────────────

describe("A1 e2e — provisioning", () => {
  test("the config of record validates: one Home, operator-as-user, three bot- ceilings", () => {
    const config = validateManagerConfig(MANAGER_CONFIG);
    expect(config.homes).toHaveLength(1);
    expect(config.homes[0]!.owner).toEqual({ kind: "user", id: "operator" });
    expect(config.homes[0]!.gatewayBaseUrl).toBe(GATEWAY);
    expect(config.bots.map((b) => b.id)).toEqual(["bot-dev", "bot-qa", "bot-maintenance"]);
    for (const bot of config.bots) {
      expect(bot.spendCeilingUsd).toBeGreaterThan(0);
    }
  });

  test("the seam fakes provision the three managers: tokens ×4 per bot, one reservation per bot at its ceiling", () => {
    const config = validateManagerConfig(MANAGER_CONFIG);
    const fakes = createSeamFakes({ gatewayUrl: GATEWAY, owner: { kind: "user", id: "operator" } });

    for (const bot of config.bots) {
      fakes.addBot(bot.id);
      fakes.writeProfileTokens(fakes.home, bot.id);
      fakes.reserveBudget(bot.id, bot.spendCeilingUsd);
    }

    // S03b: four token NAMES per bot, written for every manager.
    expect(fakes.profileTokenAudit).toHaveLength(3);
    for (const bot of config.bots) {
      const path = `/fake-homes/${fakes.home.id}/bots/${bot.id}/profile-env`;
      expect([...fakes.profilePaths.get(path)!]).toEqual([...PROFILE_TOKEN_NAMES]);
    }

    // AC4/INV-MGR-4: one reservation per manager, each at (never above) its
    // configured ceiling.
    expect(fakes.budgetJournal).toHaveLength(3);
    for (const bot of config.bots) {
      const reservations = fakes.budgetJournal.filter((r) => r.botId === bot.id);
      expect(reservations).toHaveLength(1);
      expect(reservations[0]!.ceilingUsd).toBe(bot.spendCeilingUsd);
    }
  });
});

// ─── B. the digest, through the REAL composer ────────────────────────────────
// fakeCli / costView / record / event / captureInto live in the shared
// tests/managers/fixture-helpers.ts (review finding D15 — one copy, both
// suites); afterEach unwinds through restoreCaptures().

afterEach(restoreCaptures);

describe("A1 e2e — the digest invocation", () => {
  const parkRequestedAt = new Date(NOW.getTime() - PARK_THRESHOLD_MS - 1).toISOString();
  const FLEET_MICRO_USD = new Map([
    ["run-a1-app", 1_234_567],
    ["run-a1-fix", 89],
    ["run-a1-six", 5_000],
  ]);

  /**
   * The real composer's deps: the journaled fake CLI; the gateway-spend
   * reader backed by the fakes' budget journal (per-bot USD figures); the
   * cost-ledger dep backed by fixture rows (integer micro-USD); runMeta at
   * the A1 default — no manager-originated run exists.
   */
  function e2eDeps(
    cli: CliInvoker,
    budgetJournal: readonly { botId: string; ceilingUsd: number }[],
  ): { deps: DigestDeps; gatewaySpendUsd: (botId: string) => number | undefined } {
    let reqSeq = 0;
    const gatewaySpendUsd = (botId: string): number | undefined =>
      budgetJournal.find((r) => r.botId === botId)?.ceilingUsd;
    const records = new Map<string, RunRecord>([
      [
        "run-a1-app",
        record("run-a1-app", {
          approval: { state: "awaiting-approval", requestedAt: parkRequestedAt, reportId: "rep-a1" },
        }),
      ],
      ["run-a1-fix", record("run-a1-fix", { fixLoop: { fixAttemptRunIds: ["a1f1", "a1f2"] } })],
      ["a1f1", record("a1f1", { fixLoop: { fixOutcomeClass: "ci-red" } })],
      ["a1f2", record("a1f2", { fixLoop: { fixOutcomeClass: "ci-red" } })],
    ]);
    return {
      deps: {
        cli,
        readRecord: (runId) => records.get(runId),
        costLedger: { readRunCost: (runId) => costView(FLEET_MICRO_USD.get(runId) ?? 0) },
        botTurnSpendUsd: gatewaySpendUsd,
        runMeta: () => undefined,
        now: () => NOW,
        requestId: () => `req-e2e-${++reqSeq}`,
      },
      gatewaySpendUsd,
    };
  }

  test("the full loop: journaled CLI, join keys, three escalation marks, complete last, both ledger reads", async () => {
    // Provision exactly as leg A did, so the digest's journal-backed reader
    // reads the reservations this loop itself recorded.
    const config = validateManagerConfig(MANAGER_CONFIG);
    const fakes = createSeamFakes({ gatewayUrl: GATEWAY, owner: { kind: "user", id: "operator" } });
    for (const bot of config.bots) {
      fakes.addBot(bot.id);
      fakes.writeProfileTokens(fakes.home, bot.id);
      fakes.reserveBudget(bot.id, bot.spendCeilingUsd);
    }

    const lines = captureInto();
    const { cli, journal } = fakeCli({
      statusRows: [
        { runId: "run-a1-app", state: "awaiting-approval", createdAt: NOW.toISOString() },
        { runId: "run-a1-fix", state: "closed", createdAt: NOW.toISOString() },
        { runId: "run-a1-six", state: "closed", createdAt: NOW.toISOString() },
      ],
      resultRc: (runId) => (runId === "run-a1-six" ? 6 : 0),
    });
    const { deps, gatewaySpendUsd } = e2eDeps(cli, fakes.budgetJournal);

    const outcome = await composeDigest(deps, {});

    expect(outcome.outcome).toBe("composed");
    expect(outcome.exitCode).toBe(DIGEST_EXIT.composed);

    // Exactly the two permitted verbs, then nothing: status once, result once
    // per run (AC2's read-only surface, journaled).
    expect(journal.map((j) => j.verb)).toEqual(["status", "result", "result", "result"]);
    expect(journal[0]!.argv).toEqual(["status", "--driver", "exedev"]);
    expect(journal.slice(1).map((j) => j.argv[1])).toEqual([
      "run-a1-app",
      "run-a1-fix",
      "run-a1-six",
    ]);

    // Snapshot counters: A1's truth is all-fleet-only.
    const snap = event(lines, "digest-snapshot")[0]!;
    expect(snap.runs_observed).toBe(3);
    expect(snap.truncated).toBe(0);
    expect(snap.approvals_parked).toBe(1);
    expect(snap.fixloops_active).toBe(0);
    expect(snap.bots_aggregated).toBe(0);

    // Every per-run line: workKey in `w:` form + runId, botId ABSENT (never
    // null), bot_turn_spend_usd ABSENT (never 0), the fixture's integer
    // fleet micro-USD verbatim (AC5's absent-not-null / absent-not-0).
    const runLines = event(lines, "digest-run");
    expect(runLines).toHaveLength(3);
    for (const line of runLines) {
      expect(/^w:.+$/.test(line.workKey as string)).toBe(true);
      expect(typeof line.runId).toBe("string");
      expect("botId" in line).toBe(false);
      expect(line.botId).toBeUndefined();
      expect("bot_turn_spend_usd" in line).toBe(false);
      expect(Number.isInteger(line.fleet_spend_micro_usd)).toBe(true);
      expect(line.fleet_spend_micro_usd).toBe(FLEET_MICRO_USD.get(line.runId as string));
    }

    // The gateway reader is real and journal-backed even though the A1
    // default runMeta never routes it onto a line — both ledger reads are
    // proven: the factory ledger above, the gateway figure here.
    expect(gatewaySpendUsd("bot-qa")).toBe(6);

    // The three escalation marks, one per kind, in run order.
    expect(event(lines, "digest-escalation")).toEqual([
      expect.objectContaining({ kind: "approval-park", approvalId: "rep-a1" }),
      expect.objectContaining({ kind: "fixloop-exhausted", runId: "run-a1-fix" }),
      expect.objectContaining({ kind: "exit-6", runId: "run-a1-six" }),
    ]);

    // digest-complete is the last line the channel heard.
    expect(lines[lines.length - 1]!.event).toBe("digest-complete");
    expect(event(lines, "digest-complete")).toHaveLength(1);
  });

  test("a manager-associated run renders botId, the stamped workKey, and USD beside micro-USD (P14/audit#7)", async () => {
    const lines = captureInto();
    const { cli } = fakeCli({
      statusRows: [{ runId: "run-a1-fix", state: "closed", createdAt: NOW.toISOString() }],
    });
    const deps: DigestDeps = {
      cli,
      readRecord: () => undefined,
      costLedger: { readRunCost: (runId) => costView(FLEET_MICRO_USD.get(runId) ?? 0) },
      botTurnSpendUsd: (botId) => (botId === "bot-qa-mgr" ? 0.42 : undefined),
      // The A2-shape wiring: one fixture run is manager-associated.
      runMeta: (runId) => (runId === "run-a1-fix" ? { botId: "bot-qa-mgr", workKey: "w:qa-fix-42" } : undefined),
      now: () => NOW,
      requestId: () => "req-assoc-1",
    };

    const outcome = await composeDigest(deps, {});

    expect(outcome.outcome).toBe("composed");
    const line = event(lines, "digest-run")[0]!;
    expect(line.botId).toBe("bot-qa-mgr");
    expect(line.workKey).toBe("w:qa-fix-42");
    // Both denominations side by side, NEVER converted: the gateway USD
    // figure verbatim beside the factory ledger's integer micro-USD.
    expect(line.bot_turn_spend_usd).toBe(0.42);
    expect(line.fleet_spend_micro_usd).toBe(89);
    expect(Number.isInteger(line.fleet_spend_micro_usd)).toBe(true);
    expect(event(lines, "digest-snapshot")[0]!.bots_aggregated).toBe(1);
  });
});

// ─── C. the CI-green invariant (charter §5.4) ────────────────────────────────

describe("A1 e2e — zero fork code in the manager graph", () => {
  const MANAGER_SOURCES = [
    join(REPO_ROOT, "src", "managers", "manager-config.ts"),
    join(REPO_ROOT, "src", "managers", "digest-composer.ts"),
    join(REPO_ROOT, "scripts", "manager-digest.ts"),
  ];

  test("no import line of the three manager source files carries a fork marker", () => {
    expect(forkImportOffenders(MANAGER_SOURCES, (f) => readFileSync(f, "utf8"))).toEqual([]);
  });
});

// ─── D. the real binary ───────────────────────────────────────────────────────

describe("A1 e2e — the bounded CLI (bun scripts/manager-digest.ts)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "manager-digest-e2e-"));

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** A fixture fleet entry the CLI's QDS_MANAGER_FLEET_ENTRY seam points at. */
  function writeFakeFleetEntry(): string {
    const path = join(tmp, "fake-fleet-entry.mjs");
    const createdAt = NOW.toISOString();
    writeFileSync(
      path,
      `const verb = process.argv[2];
if (verb === "status") {
  console.log(JSON.stringify({ runId: "run-cli-1", state: "closed", createdAt: ${JSON.stringify(createdAt)} }));
  process.exit(0);
}
if (verb === "result") process.exit(0);
process.exit(2);
`,
    );
    return path;
  }

  function writeConfigFixture(name: string, config: unknown): string {
    const path = join(tmp, name);
    writeFileSync(path, JSON.stringify(config));
    return path;
  }

  // Per-leg runs dir: the CLI's run lock lands in its own tmpdir, never the
  // repo's .sandbox/runs (an explicit QDS_RUNS_DIR in extraEnv still wins).
  let legSeq = 0;
  async function runCli(
    args: string[],
    extraEnv: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", join(REPO_ROOT, "scripts", "manager-digest.ts"), ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, QDS_RUNS_DIR: join(tmp, `runs-leg-${++legSeq}`), ...extraEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test(
    "a good config composes through the real binary: exit 0, the digest channel heard on stdout",
    async () => {
      const configPath = writeConfigFixture("good-config.json", MANAGER_CONFIG);
      // An empty (fully-checkpointed) ledger in tmp — the read-only open must
      // degrade to absent figures, never crash and never fabricate a 0.
      const ledgerPath = join(tmp, "cost-ledger.db");
      writeFileSync(ledgerPath, "");
      chmodSync(ledgerPath, 0o600);

      const { code, stdout } = await runCli(["--driver", "exedev", "--config", configPath], {
        QDS_MANAGER_FLEET_ENTRY: writeFakeFleetEntry(),
        QDS_COST_LEDGER_FILE: ledgerPath,
        QDS_LOG_VERBOSE: "1",
      });
      expect(code).toBe(DIGEST_EXIT.composed);
      expect(stdout).toContain('"event":"digest-snapshot"');
      expect(stdout).toContain('"event":"digest-run"');
      expect(stdout).toContain('"event":"digest-complete"');
      // All-fleet-only through the real binary too: no botId, no bot spend.
      expect(stdout).not.toContain("botId");
      expect(stdout).not.toContain("bot_turn_spend_usd");
    },
    30_000,
  );

  test(
    "an org-owner config is refused through the real binary: exit 2 and the named error on stderr",
    async () => {
      const configPath = writeConfigFixture("org-owner-config.json", {
        ...MANAGER_CONFIG,
        homes: [{ owner: { kind: "org", id: "acme" }, gatewayBaseUrl: GATEWAY }],
      });
      const { code, stderr } = await runCli(["--driver", "exedev", "--config", configPath], {
        QDS_MANAGER_FLEET_ENTRY: join(tmp, "never-invoked.mjs"),
        QDS_COST_LEDGER_FILE: join(tmp, "never-opened.db"),
      });
      expect(code).toBe(DIGEST_EXIT.configRefused);
      expect(stderr).toContain("org-owner-refused");
      expect(stderr).toContain("company-bot");
    },
    30_000,
  );

  test(
    "an unknown flag is refused by name before anything runs",
    async () => {
      const { code, stderr } = await runCli(["--daemon"], {});
      expect(code).toBe(DIGEST_EXIT.configRefused);
      expect(stderr).toContain("--daemon");
    },
    30_000,
  );

  test(
    "a --driver other than exedev is refused by name (the wrong-driver fence)",
    async () => {
      const { code, stderr } = await runCli(["--driver", "other"], {});
      expect(code).toBe(DIGEST_EXIT.configRefused);
      expect(stderr).toContain("--driver other");
      expect(stderr).toContain("exedev");
    },
    30_000,
  );

  test(
    "a missing --config path is refused with the config-unreadable envelope",
    async () => {
      const { code, stderr } = await runCli(["--config", join(tmp, "no-such-config.json")], {});
      expect(code).toBe(DIGEST_EXIT.configRefused);
      const envelope = JSON.parse(stderr.trim()) as { error: { code: string } };
      expect(envelope.error.code).toBe("config-unreadable");
    },
    30_000,
  );

  test(
    "a dead fleet entry degrades to status-unavailable: exit 1, the reason on stderr, digest-complete still on the channel",
    async () => {
      const deadEntry = join(tmp, "dead-fleet-entry.mjs");
      writeFileSync(deadEntry, "process.exit(3);\n");
      const configPath = writeConfigFixture("degraded-config.json", MANAGER_CONFIG);
      const { code, stdout, stderr } = await runCli(["--config", configPath], {
        QDS_MANAGER_FLEET_ENTRY: deadEntry,
        QDS_COST_LEDGER_FILE: join(tmp, "degraded-ledger.db"),
        QDS_LOG_VERBOSE: "1",
      });
      expect(code).toBe(DIGEST_EXIT.statusUnavailable);
      expect(stderr).toContain("manager-digest: fleet status exited 3");
      // The channel still heard the full digest, degraded figures absent.
      expect(stdout).toContain('"event":"digest-complete"');
    },
    30_000,
  );

  test(
    "a held digest run lock coalesces: exit 0, the coalesced line on stderr, no digest ran",
    async () => {
      const configPath = writeConfigFixture("coalesce-config.json", MANAGER_CONFIG);
      const runsDir = join(tmp, "runs-coalesce");
      mkdirSync(runsDir, { recursive: true });
      // Same lock name the CLI uses, in the runs dir the child is pointed at
      // through the same $QDS_RUNS_DIR chain — a genuinely held lock.
      const lock = acquireRunLock(runsDir, "manager-digest", "manager-digest-e2e");
      try {
        const { code, stdout, stderr } = await runCli(["--config", configPath], {
          QDS_MANAGER_FLEET_ENTRY: join(tmp, "never-invoked.mjs"),
          QDS_COST_LEDGER_FILE: join(tmp, "never-opened.db"),
          QDS_RUNS_DIR: runsDir,
          QDS_LOG_VERBOSE: "1",
        });
        // Coalescing is SUCCESS, not failure (gitnexus-refresh.sh's rule).
        expect(code).toBe(DIGEST_EXIT.composed);
        expect(stderr).toContain("manager-digest: another digest is running — coalesced");
        expect(stdout).not.toContain("digest-complete");
      } finally {
        releaseRunLock(lock);
      }
    },
    30_000,
  );

  test(
    "an uncreatable runs dir is a pre-flight infra failure: exit 3, one diagnostic line, no stack trace",
    async () => {
      // Portable unwritable target: a FILE in tmp, so mkdirSync(recursive)
      // under it throws ENOTDIR on any platform — no root-dependent chmod 000.
      const blocker = join(tmp, "not-a-dir");
      writeFileSync(blocker, "a file, not a directory");
      const configPath = writeConfigFixture("infra-config.json", MANAGER_CONFIG);
      const { code, stdout, stderr } = await runCli(["--config", configPath], {
        QDS_RUNS_DIR: join(blocker, "runs"),
        QDS_MANAGER_FLEET_ENTRY: join(tmp, "never-invoked.mjs"),
        QDS_COST_LEDGER_FILE: join(tmp, "never-opened.db"),
      });
      expect(code).toBe(3);
      expect(stderr).toContain("manager-digest: pre-flight infra failure:");
      // The documented contract is one stderr line: no bun error banner, no
      // unhandled-rejection stack escaping the exit table.
      expect(stderr).not.toContain("error:");
      expect(stderr).not.toContain("    at ");
      expect(stdout).not.toContain("digest-complete");
    },
    30_000,
  );

  test(
    "a flag value that is itself a flag is refused as a missing value (flag --driver requires a value)",
    async () => {
      const { code, stderr } = await runCli(["--driver", "--config"], {});
      expect(code).toBe(DIGEST_EXIT.configRefused);
      expect(stderr).toContain("flag --driver requires a value");
    },
    30_000,
  );

  test(
    "a STALE digest run lock (holder proven dead) does NOT coalesce: exit 3, the stale diagnostic naming the lock and the rm",
    async () => {
      const configPath = writeConfigFixture("stale-config.json", MANAGER_CONFIG);
      const runsDir = join(tmp, "runs-stale");
      mkdirSync(runsDir, { recursive: true });
      // A proven-dead holder: spawn a process, wait for its exit, use its pid
      // (the lock body format is `<pid> <host> <createdAt-ISO> <nonce>`). The
      // HOST field comes from a real lock the module itself wrote — the raw
      // host spelling is module-private (hostTag is its folded filename
      // form), so acquiring and reading a probe lock derives it by
      // construction on every platform.
      const probe = acquireRunLock(runsDir, "probe-run", "manager-digest-e2e");
      const probeHost = readFileSync(join(runsDir, "probe-run.lock"), "utf8").trim().split(/\s+/)[1]!;
      releaseRunLock(probe);
      const victim = Bun.spawn(["true"]);
      await victim.exited;
      // Guard against pid reuse flipping the classification: the pid MUST be
      // provably dead, or the fixture is wrong (fail loudly, never flakily).
      expect(isAlive(victim.pid)).toBe(false);
      const lockPath = join(runsDir, "manager-digest.lock");
      writeFileSync(lockPath, `${victim.pid} ${probeHost} ${new Date().toISOString()} deadbeef\n`);
      const { code, stdout, stderr } = await runCli(["--config", configPath], {
        QDS_MANAGER_FLEET_ENTRY: join(tmp, "never-invoked.mjs"),
        QDS_COST_LEDGER_FILE: join(tmp, "never-opened.db"),
        QDS_RUNS_DIR: runsDir,
      });
      // A live-held lock coalesces (exit 0 — the leg above); a stale one is
      // an operator-territory lock, routed to the pre-flight infra lane.
      expect(code).toBe(3);
      expect(stderr).toContain("manager-digest: stale run lock:");
      expect(stderr).toContain(lockPath);
      expect(stderr).toContain(`rm ${lockPath}`);
      expect(stdout).not.toContain("digest-complete");
    },
    30_000,
  );

  test(
    "an unopenable cost ledger leaves fleet_spend_micro_usd ABSENT on stdout — absent-not-0 through the real binary",
    async () => {
      const configPath = writeConfigFixture("ledger-dir-config.json", MANAGER_CONFIG);
      // A DIRECTORY, not a database: the read-only open must refuse, and the
      // digest must degrade to absent figures, never a fabricated 0.
      const ledgerDir = join(tmp, "ledger-is-a-dir");
      mkdirSync(ledgerDir, { recursive: true });
      const { code, stdout } = await runCli(["--config", configPath], {
        QDS_MANAGER_FLEET_ENTRY: writeFakeFleetEntry(),
        QDS_COST_LEDGER_FILE: ledgerDir,
        QDS_LOG_VERBOSE: "1",
      });
      expect(code).toBe(DIGEST_EXIT.composed);
      expect(stdout).toContain('"event":"digest-run"'); // the digest still fired
      expect(stdout).not.toContain("fleet_spend_micro_usd"); // absent, never 0
    },
    30_000,
  );
});
