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
 *   4. v6a production-reality inertness: with no consult producer AND no
 *      carrier injection in the production graph (no `deps.consultContext`,
 *      no `deps.consultCarrierRoot` — the real factory tree has no
 *      veto-window carrier yet), the consult reports `verdict-absent` +
 *      `policy-off` and the chain always parks.
 *   5. AC2 observability: a present-but-OFF policy consults with `policy-off`
 *      and parks.
 *   6. revocation-between-reads: the operator revokes mid-chain (the injected
 *      consultContext rewrites policy.json to autoMergeDefault:false) — the
 *      consult saw ON, the mint-time re-read sees OFF, no decision mints.
 *   7. consult-throws: an injected consultContext that throws — surfaced as
 *      exactly one auto-merge-consult-error event, no consult event, park.
 *   8. human-decision protection (ADR-2 clause 5, "the human override is
 *      unconditional"): a human approval decided while the chain runs —
 *      written through the consultContext seam, which sits after the chain's
 *      #382 pre-registration and before the gate reads the record — drives the
 *      gate's already-decided arm; the policy mint never fires and the human
 *      approverId/reason stand untouched.
 *   9. deleted-to-absent revocation: like arm 6 but the consultContext side
 *      effect DELETES the policy file — the mint-time re-read sees ABSENT, no
 *      decision mints.
 *   10. verdict-rejected drives the real chain: an eligible-shaped context
 *      whose verdict status is "rejected" consults verdict-rejected and parks.
 *   11. human-wins-at-mint (round-4 guard): a decision landing between the
 *      gate's registration and the mint is seen by the store's record-lock
 *      recheck — the mint refuses, the human approverId stands, one
 *      auto-merge-approval-skip line.
 *   12. mint-fault isolation (round-4): a throwing setApprovalIfAwaiting is
 *      failure-isolated — one auto-merge-approval-error line, the outcome
 *      stays driven, the gate's parked awaiting-approval stands.
 *
 * Same-completion-call supersession (the gate's transient awaiting-approval
 * write, then the policy decision across the reverify await — documented in
 * run-completion.ts) is asserted on FINAL persisted state only, never on write
 * order.
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
import type { CostLedger } from "../../src/providers/cost-ledger.ts";
import type { CostLedgerHook } from "../../src/providers/teardown.ts";
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

// ─── fixtures — the tests/fleet/run-completion.test.ts:1386+ chain arrangement, rebuilt local ──
// SYNC DUTY: this is a deliberate copy of that arrangement, not a shared helper;
// a change on either side must review the other for divergence.

type MarkerPlan = { body: Record<string, unknown> | null };

function store(Ctor: typeof RunRecordStore = RunRecordStore): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1chain-"));
  return {
    dir,
    store: new Ctor({ dir }),
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

function quietLedger(): CostLedgerHook {
  return {
    ingestBoxHours: () => ({ eventId: "quiet", inserted: false, unpriced: false }),
  };
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
    // ONE structural cast, typed to the real deps interface (not `never`): the
    // chain's teardown consumes the ledger only through CostLedgerHook's
    // `ingestBoxHours` (teardown's DF2.8 structural handle, which quietLedger
    // satisfies exactly); the full CostLedger class surface is fixture-unwritable.
    costLedger: quietLedger() as CostLedger,
    recordAuditLink: () => {},
    consultContext: over.consultContext,
    consultCarrierRoot: over.consultCarrierRoot,
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

/**
 * The clause-5 carrier, fabricated in a tmp tree SHAPED like the factory tree
 * (module at <root>/src/fleet/veto-window.ts, suite at <root>/tests/fleet/
 * veto-window.test.ts) so the probe — anchored to the carrierRoot handed to
 * it via deps.consultCarrierRoot, never the host tree — finds a live queue.
 * Returns the carrierRoot to pass. Injection ONLY: the real factory tree
 * gains its carrier with the veto-window story, never from a fixture.
 */
function fabricateCarrier(root: string): string {
  fs.mkdirSync(path.join(root, "src", "fleet"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "fleet", "veto-window.ts"), "export function enqueueVetoWindow(q: unknown): void {}\n");
  fs.mkdirSync(path.join(root, "tests", "fleet"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "fleet", "veto-window.test.ts"),
    'test("queues", () => { enqueueVetoWindow(undefined); });\n',
  );
  return path.join(root, "src", "fleet");
}

/**
 * A git host shaped like run-completion.test.ts's, whose `.factory/policy.json`
 * posture is chosen per arm — the policy is written BEFORE the base commit so
 * the host tree stays clean for reverify's tree-clean phase. The policy file
 * is 0600 (the `.factory/` posture the guarded read demands; a looser file is
 * `policy-unreadable`, i.e. OFF).
 *
 * `ignorePolicy` (revocation arm only) leaves the policy file UNTRACKED
 * (gitignored, shipped posture): that arm rewrites the file mid-chain, and a
 * tracked rewrite would dirty the tree so reverify's tree-clean phase vetoes
 * before the mint-time re-read can see the revocation.
 *
 * The committed policy file is FIXTURE-ONLY scaffolding: reverify's tree-clean
 * needs a clean tracked tree and the loader needs the file present at the
 * default path, so the fixture commits it with the base. A real operator
 * NEVER commits it — `.factory/` is gitignored in the shipped posture and
 * policy lives out-of-tree.
 */
function gitHost(policy: "absent" | "on" | "off", ignorePolicy = false): GitHost {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-g1chain-repo-"));
  const run = (argv: string[], cwd = dir): string => gitRun(argv, cwd);
  run(["git", "init", "-q", "-b", "main"]);
  run(["git", "config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ignorePolicy ? ".sandbox/\n.factory/policy.json\n" : ".sandbox/\n");
  fs.mkdirSync(path.join(dir, ".factory", "manifests"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".factory", "manifests", "acme-widget.json"), JSON.stringify(HOST_MANIFEST));
  fs.writeFileSync(
    path.join(dir, ".factory", "pipeline.json"),
    JSON.stringify({ version: 1, repos: { "acme/widget": { manifest: ".factory/manifests/acme-widget.json" } } }),
  );
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

/**
 * `deps.consultContext`'s return, parameterized by the arm's diff — the
 * trusted DI seam, j3 precedent. `rebasedAt` is threaded (a Date BEFORE the
 * verdict's producedAt) because a verdict present without a rebase stamp is
 * `verdict-stale` by contract — an eligible arm cannot omit it.
 */
function injectedConsult(runId: string, diffPaths: string[], scopeGlobs: string[], verdictStatus: QaVerdict["status"] = "approved") {
  return {
    input: {
      runId,
      diffPaths,
      diffEntries: diffPaths.map((p) => ({ path: p, action: "modify" as const })),
      scope: { allowedPathGlobs: scopeGlobs, deniedPathGlobs: [], permittedActions: ["modify" as const] },
      rebasedAt: new Date(Date.now() - 120_000),
    },
    verdict: { status: verdictStatus, producedAt: new Date(Date.now() - 60_000).toISOString(), escalated: false } satisfies QaVerdict,
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
        // the fabricated carrier rides the store tmpdir — s.cleanup() removes it
        const out = await observeAndDriveChain(
          "run-g1b",
          baseDeps("run-g1b", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => injectedConsult("run-g1b", ["src/feature/x.ts"], ["src/feature/**"]),
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // ONE consult event, eligible with the contract's satisfied-requirements
        // reasons list — every clause named as passed, not an empty array.
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({
          runId: "run-g1b",
          eligible: true,
          reasons: ["never-path-clear", "scope-ok", "verdict-fresh", "policy-on"],
        });
        // DD-28.26(2) home: the merge decision is recorded where every approved
        // run's decision is recorded — FINAL persisted state only (the gate's
        // transient awaiting-approval write is superseded within the same
        // completion call, across the reverify await).
        const approval = s.store.get("run-g1b").extensions?.approval;
        // store.set merges per-field, so the decision's four fields land ON the
        // gate's registration entry — toMatchObject pins the decision fields.
        expect(approval).toMatchObject({
          state: "approved",
          approverId: POLICY_AUTO_MERGE_APPROVER_ID,
          reason: "adr-2-auto-merge",
        });
        expect(typeof approval?.decidedAt === "string" && !Number.isNaN(new Date(approval.decidedAt).getTime())).toBe(true);
        // The per-field-merge chimera is the SANCTIONED shape: the decision's
        // four fields land ON the gate's registration entry, so a registration
        // field persists beside them — and DD-28.26(2) and approval-gate's
        // decisionOf read state/approverId off this same entry.
        expect(typeof approval?.requestedAt).toBe("string");
        expect(typeof approval?.expiresAt).toBe("string");
        // a non-approval extension namespace seeded before the chain survives
        // the superseding write untouched
        expect(s.store.get("run-g1b").extensions?.budget).toMatchObject({ repoSlug: "acme/widget", issueId: "7" });
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
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
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
        // production default: NO injection at all — deps.consultContext is
        // ABSENT (RunRecord carries no diff/scope carrier and no factory_result
        // verdict ⇒ buildConsultContext's empty carriers) and
        // deps.consultCarrierRoot is ABSENT, so the clause-5 probe reads the
        // REAL factory build tree, which has no veto-window carrier yet: the
        // ON-tree policy file consults OFF (clause5-carrier-absent). v6a
        // production reality: the chain parks twice over.
        const out = await observeAndDriveChain(
          "run-g1d",
          baseDeps("run-g1d", { driver, store: s.store, runsDir: s.dir, hostRoot: host.dir }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({
          runId: "run-g1d",
          eligible: false,
          // the default extraction's EMPTY diffEntries is its own failing
          // clause (scope), listed before the verdict and policy failures
          reasons: ["scope", "verdict-absent", "policy-off"],
          policy_off: "clause5-carrier-absent",
        });
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
          // no producer ⇒ the default extraction's empty carriers fail scope
          // and verdict; the OFF policy adds its own clause
          reasons: ["scope", "verdict-absent", "policy-off"],
          // the consult result's policyOff (stateReason when off), on the
          // event as snake_case beside the chain-event convention
          policy_off: "declared-off",
        });
        expect(s.store.get("run-g1e").extensions?.approval?.state).toBe("awaiting-approval");
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC revocation-between-reads: the consult saw ON but the operator revokes mid-chain — the mint-time re-read sees OFF and NO decision mints",
    async () => {
      const lines = captureLogs();
      const s = store();
      // ignorePolicy: the arm rewrites the policy file mid-chain; untracked is
      // the shipped posture and keeps reverify's tree-clean phase green.
      const host = gitHost("on", true);
      try {
        quarantine(host, "run-g1f");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1f", { ok: true });
        const policyPath = path.join(host.dir, ".factory", "policy.json");
        const out = await observeAndDriveChain(
          "run-g1f",
          baseDeps("run-g1f", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            // SIDE EFFECT before returning: the operator's revocation lands
            // while reverify runs — the consult (already past the pre-read)
            // still saw ON; only the mint-time re-read sees OFF.
            consultContext: () => {
              fs.writeFileSync(policyPath, JSON.stringify({ autoMergeDefault: false }));
              return injectedConsult("run-g1f", ["src/feature/x.ts"], ["src/feature/**"]);
            },
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // exactly one consult event, eligible — the consult evaluated against
        // the still-ON pre-read
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1f", eligible: true });
        expect(lines.filter((l) => l.event === "auto-merge-consult-error")).toHaveLength(0);
        // the re-read saw OFF ⇒ no mint; the gate's park stands as final state
        expect(s.store.get("run-g1f").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1f"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC consult-throws: policy present-ON with an injected consultContext that throws — NO consult event, exactly one consult-error event, fail-closed park",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1g");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1g", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1g",
          baseDeps("run-g1g", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => {
              throw new Error("injected consult failure");
            },
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // the consult never ran ⇒ no consult event; the fold surfaced exactly once
        expect(consultEvents(lines)).toHaveLength(0);
        expect(lines.filter((l) => l.event === "auto-merge-consult-error")).toHaveLength(1);
        expect(s.store.get("run-g1g").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1g"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC human-decision protection (ADR-2 clause 5: \"the human override is unconditional\"): a human approval decided while the chain runs is never displaced by the policy decision",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1h");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1h", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1h",
          baseDeps("run-g1h", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => {
              // The human decision lands through the consultContext seam —
              // AFTER the chain's #382 pausing pre-registration and BEFORE the
              // gate reads the record — so the gate's already-decided arm (a
              // TERMINAL state) answers WITHOUT writing, and the policy mint
              // never fires (it rides the `requested` outcome only). ADR-2
              // clause 5: "the human override is unconditional" — a policy
              // decision may never displace one.
              s.store.set("run-g1h", {
                extensions: {
                  approval: {
                    state: "approved",
                    approverId: "human:steve",
                    decidedAt: new Date().toISOString(),
                    reason: "manual",
                  },
                },
              });
              return injectedConsult("run-g1h", ["src/feature/x.ts"], ["src/feature/**"]);
            },
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        // the non-requested mapping: the gate's already-decided answer lands
        // as handed-off, not driven
        expect(out).toMatchObject({ kind: "handed-off", outcome: "already-decided" });
        // the consult itself still ran — eligible against the still-ON policy
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1h", eligible: true });
        expect(lines.filter((l) => l.event === "auto-merge-consult-error")).toHaveLength(0);
        // the HUMAN approverId/reason survive verbatim on the persisted
        // approval — the gate wrote nothing, and no labeled approver exists
        // anywhere on the record
        expect(s.store.get("run-g1h").extensions?.approval).toMatchObject({
          state: "approved",
          approverId: "human:steve",
          reason: "manual",
        });
        expect(JSON.stringify(s.store.get("run-g1h"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC deleted-to-absent revocation: the consult saw ON but the operator DELETES the policy file mid-chain — the mint-time re-read sees ABSENT and no decision mints",
    async () => {
      const lines = captureLogs();
      const s = store();
      // ignorePolicy: the arm removes the (untracked) policy file mid-chain,
      // so reverify's tree-clean phase stays green.
      const host = gitHost("on", true);
      try {
        quarantine(host, "run-g1i");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1i", { ok: true });
        const policyPath = path.join(host.dir, ".factory", "policy.json");
        const out = await observeAndDriveChain(
          "run-g1i",
          baseDeps("run-g1i", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            // SIDE EFFECT before returning: the file is GONE while reverify
            // runs — the consult (past the pre-read) saw ON; the mint-time
            // re-read sees ABSENT.
            consultContext: () => {
              fs.rmSync(policyPath);
              return injectedConsult("run-g1i", ["src/feature/x.ts"], ["src/feature/**"]);
            },
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        // exactly one consult event, eligible — evaluated against the
        // still-present pre-read; no error fold fired
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({ runId: "run-g1i", eligible: true });
        expect(lines.filter((l) => l.event === "auto-merge-consult-error")).toHaveLength(0);
        // the re-read saw ABSENT ⇒ no mint; the gate's park stands as final
        expect(s.store.get("run-g1i").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1i"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC verdict-rejected drives the real chain: an eligible-shaped context whose QA verdict status is rejected consults verdict-rejected and parks awaiting-approval",
    async () => {
      const lines = captureLogs();
      const s = store();
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1j");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1j", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1j",
          baseDeps("run-g1j", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            // eligible-shaped diff/scope with rebasedAt threaded — the ONLY
            // failing clause is the verdict's rejected status
            consultContext: () => injectedConsult("run-g1j", ["src/feature/x.ts"], ["src/feature/**"], "rejected"),
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        expect(consultEvents(lines)[0]).toMatchObject({
          runId: "run-g1j",
          eligible: false,
          reasons: ["verdict-rejected"],
        });
        // parked; policyDecision false ⇒ no mint
        expect(s.store.get("run-g1j").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1j"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC human-wins-at-mint guard (round-4): a decision landing between the gate's registration and the mint refuses the write under the record-lock recheck",
    async () => {
      const lines = captureLogs();
      /**
       * Injects the human decision at the MINT instant — after the gate's
       * registration and its already-decided arm never see it, only the
       * store's recheck does. The honest stand-in for an operator deciding
       * while the chain crosses from reverify to the mint.
       */
      class HumanAtMintStore extends RunRecordStore {
        armed = true;
        override setApprovalIfAwaiting(
          runId: string,
          patch: Parameters<RunRecordStore["setApprovalIfAwaiting"]>[1],
        ): ReturnType<RunRecordStore["setApprovalIfAwaiting"]> {
          if (this.armed) {
            this.armed = false;
            s.store.set("run-g1k", {
              extensions: {
                approval: {
                  state: "approved",
                  approverId: "human:steve",
                  decidedAt: new Date().toISOString(),
                  reason: "manual",
                },
              },
            });
          }
          return super.setApprovalIfAwaiting(runId, patch);
        }
      }
      const s = store(HumanAtMintStore);
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1k");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1k", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1k",
          baseDeps("run-g1k", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => injectedConsult("run-g1k", ["src/feature/x.ts"], ["src/feature/**"]),
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(consultEvents(lines)).toHaveLength(1);
        // the refusal is a line, never silent
        expect(lines.filter((l) => l.event === "auto-merge-approval-skip")).toHaveLength(1);
        // the HUMAN decision stands — the mint lost the race by construction
        expect(s.store.get("run-g1k").extensions?.approval).toMatchObject({
          state: "approved",
          approverId: "human:steve",
          reason: "manual",
        });
        expect(JSON.stringify(s.store.get("run-g1k"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );

  test(
    "AC mint-fault isolation (round-4): a throwing setApprovalIfAwaiting surfaces one auto-merge-approval-error line, the outcome stays driven, the gate park intact",
    async () => {
      const lines = captureLogs();
      class MintFaultStore extends RunRecordStore {
        override setApprovalIfAwaiting(): ReturnType<RunRecordStore["setApprovalIfAwaiting"]> {
          throw new Error("mint store fault");
        }
      }
      const s = store(MintFaultStore);
      const host = gitHost("on");
      try {
        quarantine(host, "run-g1l");
        const driver = new ProbeDriver(path.join(s.dir, "boxes"));
        await seedGreenRun(s.store, driver, host, "run-g1l", { ok: true });
        const out = await observeAndDriveChain(
          "run-g1l",
          baseDeps("run-g1l", {
            driver,
            store: s.store,
            runsDir: s.dir,
            hostRoot: host.dir,
            consultContext: () => injectedConsult("run-g1l", ["src/feature/x.ts"], ["src/feature/**"]),
            consultCarrierRoot: fabricateCarrier(path.join(s.dir, "carrier-tree")),
          }),
        );
        // NO raw escape past the typed outcome — the chain genuinely landed
        expect(out).toMatchObject({ kind: "driven", markerOk: true });
        expect(lines.filter((l) => l.event === "auto-merge-approval-error")).toHaveLength(1);
        expect(lines.filter((l) => l.event === "auto-merge-approval-error")[0]).toMatchObject({
          error: expect.stringContaining("mint store fault"),
        });
        // the gate's parked state stands and stays decidable by hand
        expect(s.store.get("run-g1l").extensions?.approval?.state).toBe("awaiting-approval");
        expect(JSON.stringify(s.store.get("run-g1l"))).not.toContain(POLICY_AUTO_MERGE_APPROVER_ID);
      } finally {
        host.cleanup();
        s.cleanup();
      }
    },
    120_000,
  );
});
