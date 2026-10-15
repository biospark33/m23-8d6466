/**
 * G1 — the mandatory three-arm fake-driver chain demo for ADR-2's fail-closed
 * auto-merge policy, driven END-TO-END through the REAL chain
 * (`observeAndDriveChain`: real teardownSandbox → reverify → gate) exactly per
 * the house doctrine — the chain is steered with the record, the bundle, the
 * host repo and the `deps.consultContext` DI seam; nothing about the chain is
 * mocked. Explicitly NON-LIVE: no box, no spend, no E21 — every arm is
 * host-side and offline, in-process (FakeDriver / FakeKeyApi / throwaway git
 * host, the tests/fleet/run-completion.test.ts:1386 arrangement).
 *
 * The arms, one per story clause:
 *   1. default-park (v5-identical): no policy file → NO consult event, the
 *      gate parks `awaiting-approval` exactly as pre-G1.
 *   2. accepted-eligible labeled proceed (DD-28.26(2)): eligible consult →
 *      `extensions.approval` carries the labeled `policy:adr-2` decision;
 *      approval-gate.ts stays byte-untouched (CHANNEL ≠ POLICY).
 *   3. never-path park: `src/fleet/approval-gate.ts` in the diff parks even
 *      with the policy ON.
 *   4. v6a production-reality inertness: with no consult producer in the
 *      production graph (no `deps.consultContext`), the consult reports
 *      `verdict-absent` and the chain always parks.
 *   5. AC2 observability: a present-but-OFF policy consults with `policy-off`
 *      and parks.
 *
 * Same-tick supersession (the gate's transient awaiting-approval write, then
 * the policy decision — documented in run-completion.ts) is asserted on FINAL
 * persisted state only, never on write order.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { POLICY_AUTO_MERGE_APPROVER_ID, type QaVerdict } from "../../src/fleet/auto-merge-policy.ts";
import { type RunCompletionDeps, observeAndDriveChain } from "../../src/fleet/run-completion.ts";
import { BOX_MARKER_PATH_RE } from "../../src/fleet/fanout-primitive.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { createRun, type ExecResult } from "../../src/providers/driver.ts";
import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink } from "../../src/lib/log.ts";
import { FakeKeyApi } from "../providers/fixtures/fake-key-api.ts";
import { useTempAuditStore } from "./helpers.ts";

useTempAuditStore(); // the chain's composition roots must never touch the live .sandbox/audit.db

/**
 * Every env var the neighboring dispatch legs key on, DELETED for the whole
 * suite (copied from dispatch-router.test.ts): no config-present case may fall
 * through to a real client against the developer's env.
 */
const ENV_KEYS = [
  "MEMGATE_ADMIN_KEY",
  "QDS_MEMGATE_SIGNING_KEY",
  "QDS_KG_GATEWAY_URL",
  "QDS_MEMGATE_LEDGER",
  "HINDSIGHT_BASE_URL",
  "HINDSIGHT_BEARER_TOKEN",
  "HINDSIGHT_API_KEY",
] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * A CAPTURING log sink — the consult event and the terminal line land here
 * for field-map assertions. The restore rides the same afterEach as the
 * run-completion suite's: an un-restored sink swallows every later test's
 * log output for the rest of the process.
 */
const logRestores: Array<() => void> = [];
function captureLogs(): Array<Record<string, unknown>> {
  const lines: Array<Record<string, unknown>> = [];
  logRestores.push(
    setLogSink((entry) => {
      lines.push(entry as Record<string, unknown>);
    }),
  );
  return lines;
}
afterEach(() => {
  for (const restore of logRestores.splice(0)) restore();
});

// ─── fixtures (the run-completion.test.ts chain arrangement, rebuilt local) ───

type MarkerPlan = { body: Record<string, unknown> | null };

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1chain-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * The inline fake driver: `exec`/`execTimed` BOTH route through `intercept`
 * (readBoxFile prefers execTimed, unitActivity falls back to exec), answering
 * the marker plan per tick. This file only needs the settled-body arms — the
 * marker is settled on the first probe in every chain test here.
 */
class ProbeDriver extends FakeDriver {
  calls: Array<{ argv: readonly string[] }> = [];
  destroyed: string[] = [];
  plan: MarkerPlan[] = [{ body: null }];
  #tick = 0;
  #tickPlan: MarkerPlan | null = null;

  override async exec(vm: string, argv: string[], stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, undefined);
  }

  override async execTimed(vm: string, argv: string[], timeoutMs: number, stdin?: string): Promise<ExecResult> {
    return this.intercept(vm, argv, stdin, timeoutMs);
  }

  override async destroy(vm: string): Promise<void> {
    this.destroyed.push(vm);
    return super.destroy(vm);
  }

  private async intercept(vm: string, argv: string[], stdin?: string, timeoutMs?: number): Promise<ExecResult> {
    this.calls.push({ argv });
    const cmd = argv.length >= 3 && argv[0] === "sh" && argv[1] === "-c" && typeof argv[2] === "string" ? argv[2] : "";
    if (argv[0] === "systemctl" && argv[1] === "is-active") {
      return { stdout: "active\n", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("test -f") && BOX_MARKER_PATH_RE.test(cmd)) {
      this.#tickPlan = this.plan[Math.min(this.#tick++, this.plan.length - 1)]!;
      return "body" in this.#tickPlan && this.#tickPlan.body === null
        ? { stdout: "", stderr: "", exitCode: 1 } // test -f's clean miss
        : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("cat ") && BOX_MARKER_PATH_RE.test(cmd)) {
      const p = this.#tickPlan ?? this.plan[0]!;
      return { stdout: `${JSON.stringify("body" in p ? p.body : null)}\n`, stderr: "", exitCode: 0 };
    }
    return timeoutMs === undefined ? super.exec(vm, argv, stdin) : super.execTimed(vm, argv, timeoutMs, stdin);
  }
}

function quietLedger(): { hook: { ingestBoxHours(ctx: Record<string, unknown>): void }; ingested: Array<Record<string, unknown>> } {
  const ingested: Array<Record<string, unknown>> = [];
  return { hook: { ingestBoxHours: (ctx) => ingested.push(ctx) }, ingested };
}

function baseDeps(
  runId: string,
  over: Partial<RunCompletionDeps> & { driver: ProbeDriver; store: RunRecordStore; runsDir: string; hostRoot: string },
): RunCompletionDeps {
  return {
    driver: over.driver,
    store: over.store,
    runsDir: over.runsDir,
    hostRoot: over.hostRoot,
    runLock: path.join(over.runsDir, `${runId}.lock`) as RunCompletionDeps["runLock"],
    keyApi: new FakeKeyApi() as RunCompletionDeps["keyApi"],
    requestId: "req-g1",
    costLedger: quietLedger().hook as never,
    recordAuditLink: () => {},
    consultContext: over.consultContext,
  };
}

// ─── the throwaway git host, with an ADR-2 policy posture parameter ──────────

const HOST_MANIFEST = {
  version: "1.0.0",
  pipelineId: "host-verify-df37",
  runBudgetMs: 1_200_000,
  phases: [
    {
      name: "tests",
      kind: "code",
      description: "host-pinned test run",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["bun", "test", "t/"],
      testCommand: ["bun", "test", "t/"],
    },
    {
      name: "tree-clean",
      kind: "code",
      description: "host-pinned working tree gate",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["git", "status", "--porcelain"],
    },
  ],
};

interface GitHost {
  dir: string;
  baseSha: string;
  cleanup(): void;
}

function gitRun(argv: string[], cwd: string): string {
  const res = spawnSync(argv[0]!, argv.slice(1), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  if (res.status !== 0) throw new Error(`${argv.join(" ")} failed in ${cwd}: ${res.stderr || res.stdout}`);
  return res.stdout;
}

/** The clause-5 carrier module: declares `enqueueVetoWindow`, text-probed, never imported. */
const CARRIER_MODULE_SRC = "export function enqueueVetoWindow(q: unknown): void {}\n";
const CARRIER_TEST_SRC = [
  'import { expect, test } from "bun:test";',
  'import { enqueueVetoWindow } from "../../src/fleet/veto-window.ts";',
  'test("queues", () => { expect(enqueueVetoWindow(undefined)).toBeUndefined(); });',
  "",
].join("\n");

/**
 * A git host shaped like run-completion.test.ts's, whose `.factory/policy.json`
 * posture is chosen per arm — the policy and the clause-5 carriers are written
 * BEFORE the base commit so the host tree stays clean for reverify's
 * tree-clean phase. The policy file is 0600 (the `.factory/` posture the
 * guarded read demands; a looser file is `policy-unreadable`, i.e. OFF).
 */
function gitHost(policy: "absent" | "on" | "off"): GitHost {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1chain-repo-"));
  const run = (argv: string[], cwd = dir): string => gitRun(argv, cwd);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".sandbox/\n");
  fs.mkdirSync(path.join(dir, ".factory", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".factory", "manifests", "acme-widget.json"), JSON.stringify(HOST_MANIFEST));
  fs.writeFileSync(
    path.join(dir, ".factory", "pipeline.json"),
    JSON.stringify({ version: 1, repos: { "acme/widget": { manifest: ".factory/manifests/acme-widget.json" } } }),
  );
  if (policy === "on") {
    fs.mkdirSync(path.join(dir, "src", "fleet"), { recursive: true });
    fs.mkdirSync(path.join(dir, "tests", "fleet"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "fleet", "veto-window.ts"), CARRIER_MODULE_SRC);
    fs.writeFileSync(path.join(dir, "tests", "fleet", "veto-window.test.ts"), CARRIER_TEST_SRC);
  }
  if (policy !== "absent") {
    const body =
      policy === "on"
        ? JSON.stringify({ autoMergeDefault: true, adr2AcceptedOn: "2026-10-15", vetoWindowQueueLive: true })
        : JSON.stringify({ autoMergeDefault: false });
    const policyPath = path.join(dir, ".factory", "policy.json");
    fs.writeFileSync(policyPath, body);
    fs.chmodSync(policyPath, 0o600); // the guarded read refuses anything looser — OFF, never ON
  }
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "base"]);
  const baseSha = run(["git", "rev-parse", "HEAD"]).trim();
  return { dir, baseSha, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Quarantine the run's two work commits at refs/sandbox/<runId>, as harvest leaves them. */
function quarantine(h: GitHost, runId: string): void {
  const run = (argv: string[], cwd = h.dir): string => gitRun(argv, cwd);
  run(["git", "checkout", "-q", "-b", `work-${runId}`]);
  fs.mkdirSync(path.join(h.dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(h.dir, "src", "sum.ts"), "export function sum(a: number, b: number) {\n  return a + b;\n}\n");
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "feat: sum"]);
  fs.mkdirSync(path.join(h.dir, "t"), { recursive: true });
  fs.writeFileSync(
    path.join(h.dir, "t", "sum.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'import { sum } from "../src/sum.ts";',
      'test("sums", () => { expect(sum(1, 2)).toBe(3); });',
      "",
    ].join("\n"),
  );
  run(["git", "add", "-A"]);
  run(["git", "commit", "-q", "-m", "test: sum"]);
  const head = run(["git", "rev-parse", "HEAD"]).trim();
  run(["git", "update-ref", `refs/sandbox/${runId}`, head]);
  run(["git", "checkout", "-q", "main"]);
  run(["git", "branch", "-q", "-D", `work-${runId}`]);
}

/** The box repo at `<box>/app` whose `sbx/<runId>` branch holds the run's work. */
function seedBoxGit(driver: ProbeDriver, vm: string, host: GitHost, runId: string): void {
  const box = path.join(driver.root, vm);
  const app = path.join(box, "app");
  gitRun(["git", "clone", "-q", host.dir, app], box);
  gitRun(["git", "fetch", "-q", "origin", `refs/sandbox/${runId}`], app);
  gitRun(["git", "checkout", "-q", "-B", `sbx/${runId}`, "FETCH_HEAD"], app);
}

/**
 * The record the driven chain needs: box + pinned base + budget attribution,
 * plus a settled marker planted for the poll's first tick.
 */
async function seedGreenRun(
  s: RunRecordStore,
  driver: ProbeDriver,
  host: GitHost,
  runId: string,
  marker: { ok: boolean },
): Promise<string> {
  const rec = await createRun(driver, s, { runId, recordAuditLink: () => {} });
  seedBoxGit(driver, rec.vmName!, host, runId);
  s.set(runId, {
    commitSha: host.baseSha,
    requestId: "req-g1",
    extensions: { budget: { repoSlug: "acme/widget", issueId: "7" } },
  } as never);
  driver.plan = [{ body: { runId, ok: marker.ok, completedAt: "2026-09-15T00:00:00.000Z" } }];
  return rec.vmName!;
}

/** `deps.consultContext`'s return, parameterized by the arm's diff — the trusted DI seam, j3 precedent. */
function injectedConsult(runId: string, diffPaths: string[], scopeGlobs: string[]) {
  return {
    input: {
      runId,
      diffPaths,
      diffEntries: diffPaths.map((p) => ({ path: p, action: "modify" as const })),
      scope: { allowedPathGlobs: scopeGlobs, deniedPathGlobs: [], permittedActions: ["modify" as const] },
    },
    verdict: { status: "approved", producedAt: new Date(Date.now() - 60_000).toISOString(), escalated: false } satisfies QaVerdict,
  };
}

const consultEvents = (lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
  lines.filter((l) => l.event === "auto-merge-consult");

// ─── the arms ────────────────────────────────────────────────────────────────

describe("G1 chain demo: ADR-2 fail-closed auto-merge, driven end-to-end (non-live)", () => {
  test(
    "AC default-park (v5-identical): hostRoot without a policy file → ZERO auto-merge-consult events, the gate parks awaiting-approval exactly as pre-G1, no approved-state write",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("absent");
      try {
        quarantine(host, "run-g1a");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1a", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1a",
          baseDeps("run-g1a", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // pre-G1 park: written only by the gate, never superseded by any policy
        // decision (absent policy ⇒ no evaluation, no consult event, no write).
        expect(s.store.get("run-g1a").extensions?.approval?.state).toBe("awaiting-approval");
        expect(consultEvents(lines)).toHaveLength(0);
        // no approved-state write and no labeled approver anywhere on the record
        expect(JSON.stringify(s.store.get("run-g1a"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC5 labeled proceed (DD-28.26(2)): eligible consult drives a policy:adr-2 approved record past the gate's transient awaiting-approval; approval-gate.ts untouched",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1b");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        const vm = await seedGreenRun(s.store, driver, host, "run-g1b", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1b",
          baseDeps("run-g1b", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => injectedConsult("run-g1b", ["src/feature/x.ts"], ["src/feature/**"]),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // ONE consult event, eligible with an empty reasons list
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1b", eligible: true, reasons: [] });
        // DD-28.26(2) home: the merge decision is recorded where every approved
        // run's decision is recorded — FINAL persisted state only (the gate's
        // transient awaiting-approval write is same-tick superseded).
        const approval = s.store.get("run-g1b").extensions?.approval;
        // store.set merges per-field, so the decision's four fields land ON the
        // gate's registration entry — toMatchObject pins the decision fields.
        expect(approval).toMatchObject({
          state: "approved",
          approverId: POLICY_AUTO_MERGE_APPROVER_ID,
          reason: "adr-2-auto-merge",
        });
        expect(typeof approval?.decidedAt === "string" && !Number.isNaN(new Date(approval.decidedAt).getTime())).toBe(true);
        expect(new Date(approval!.decidedAt as string).getTime()).not.toBeNaN();
        // the chain drove all the way: box torn down with the bundle harvested
        expect(driver.destroyed).toEqual([vm]);
        // CHANNEL ≠ POLICY: the gate module carries none of the policy's
        // vocabulary — the decision was recorded beside it, not through it.
        const gateSrc = fs.readFileSync(path.join(import.meta.dir, "..", "..", "src", "fleet", "approval-gate.ts"), "utf8");
        expect(gateSrc).not.toContain("policy:adr-2");
        expect(gateSrc).not.toContain("adr-2-auto-merge");
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC never-path park regardless of setting: approval-gate.ts in the diff consults eligible:false and parks awaiting-approval even with the policy ON",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1c");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1c", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1c",
          baseDeps("run-g1c", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => injectedConsult("run-g1c", ["src/fleet/approval-gate.ts"], ["src/fleet/**"]),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1c", eligible: false, reasons: ["never-path"] });
        // parked pre-G1-style; no labeled approver anywhere on the record
        expect(s.store.get("run-g1c").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1c"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC v6a production-reality inertness: ON-tree hostRoot with NO consult producer in the graph → consult reports verdict-absent and the chain always parks",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1d");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1d", { ok: true });
        // production default: deps.consultContext is ABSENT — RunRecord carries
        // no diff/scope carrier and no factory_result verdict, so the default
        // extraction returns empty carriers (the buildConsultContext arm).
        const out = await observeAndDriveChain(
          "run-g1d",
          baseDeps("run-g1d", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1d", eligible: false, reasons: ["verdict-absent"] });
        expect(s.store.get("run-g1d").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1d"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC2 observability line: a present-but-OFF policy file consults with policy-off in its reasons and parks",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("off");
      try {
        quarantine(host, "run-g1e");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1e", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1e",
          baseDeps("run-g1e", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({
          runId: "run-g1e",
          eligible: false,
          reasons: ["verdict-absent", "policy-off"],
        });
        expect(s.store.get("run-g1e").extensions?.approval?.state).toBe("awaiting-approval");
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );
});
