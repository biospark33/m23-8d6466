/**
 * T1.7 — DF3.4's tier-1 pre-PR approval gate, end to end on real exe.dev + the
 * real OpenRouter key API + real `bun scripts/fleet.ts` subprocesses.
 *
 * This is the story's MANDATORY demo, verbatim from the DoD: "one scripted run
 * pauses, approved by allowlisted operator over stdin, leaves
 * `extensions.approval` carrying `approved` + `approverId` + `decidedAt` —
 * DF5.2 gates the PR on this."
 *
 * What only a LIVE run can prove, and why each step is here:
 *
 *  - AC1/INV-APPROVE-6 is an ORDER claim about irreversible infrastructure.
 *    `requestApproval` registers `pausing`, then really tears the box down
 *    (spend captured, key revoked AND revocation-verified, box destroyed), and
 *    only then promotes to `awaiting-approval`. The unit suite proves that
 *    against a call-order spy; here the middle step is a real destroy and a real
 *    DELETE /keys, so "the evidence outlives the irreversible step" is tested
 *    against the thing that is actually irreversible.
 *  - AC7 says a paused run whose box is GONE reports `awaiting-approval`, never
 *    `boxMissing`. No fake can prove that: the box has to be genuinely absent
 *    from a real `driver.list()` while the row still reads `awaiting-approval`.
 *  - AC4/INV-CRED-3 is a real `.factory/approvers.json` at 0600 and a real
 *    hashed token arriving on the subprocess's fd 0 — never argv, never env.
 *
 * ZERO model spend by construction: the key exists only between mint and the
 * pause's revoke, and no chat call ever references it. Minting costs $0.
 *
 * Exit codes are a TABLE (skill gotcha #6). This file asserts the map ratified
 * for DF3.4: approve/reject decided 0, already-decided 0, report-changed 5,
 * not-decidable 5, auth refusal 5; attach acked 0 / not-acked 6 /
 * run-not-attachable 5.
 */
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { requestApproval } from "../../../src/fleet/approval-gate.ts";
import { hashToken } from "../../../src/fleet/approvers.ts";
import { CostLedger, openRouterKeyApi, teardownSandbox } from "../../../src/providers/index.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { costLedgerOpts } from "../../../scripts/lib/cost-ledger-opts.ts";
import {
  REPO_ROOT,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  mintCappedKey,
  preflight,
  revokeQuietly,
  runFleet,
  runIdFor,
  tmpWorkspace,
  writeEvidence,
} from "./live-harness.ts";

/** The approver the allowlist registers. Obviously not a person's real id. */
const APPROVER_ID = "e2e-operator@example.test";
/** Obviously-fake sentinel; only its SALTED HASH is ever written to disk. */
const APPROVER_TOKEN = "fake-e2e-approver-token-do-not-reuse";
const APPROVER_SALT = "e2e-salt";

/**
 * `runFleet` with the token on fd 0. The harness's `runFleet` exposes no stdin
 * seam and adding one is a change to a shared file this test does not own, so
 * the one leg that needs it spawns directly — same cmd/cwd/env semantics.
 *
 * `stdin: Bun.file(path)` makes fd 0 a REGULAR FILE, which is exactly the
 * `fleet approve … < token` shape an operator uses and which
 * `assertTokenAttached` accepts. A character device (`/dev/null`, the default
 * for a spawned child) is refused as "no token attached" — that is the guard
 * working, not a harness bug.
 */
async function runFleetWithToken(
  argv: readonly string[],
  tokenPath: string,
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: ["bun", join(REPO_ROOT, "scripts/fleet.ts"), ...argv],
    cwd: opts.cwd,
    env: process.env as Record<string, string>,
    stdin: Bun.file(tokenPath),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [, stdout, stderr] = await Promise.all([
      Promise.race([
        proc.exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`runFleetWithToken timeout: fleet ${argv.join(" ")}`)),
            opts.timeoutMs ?? 120_000,
          );
        }),
      ]),
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).catch(async (e) => {
      proc.kill();
      throw e;
    });
    return { exitCode: await proc.exited, stdout, stderr };
  } finally {
    clearTimeout(timer);
    proc.kill();
  }
}

/** The last JSON line of a verb's stdout — the verb's OUTPUT, not its prose. */
const lastJson = <T>(stdout: string): T => JSON.parse(stdout.trim().split("\n").filter(Boolean).at(-1) ?? "{}") as T;

/** The stderr envelope a refusing verb printed, by `code`. */
function envelope(stderr: string, code: string): Record<string, unknown> | undefined {
  return stderr
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((l) => l.code === code);
}

test.todoIf(liveTodoOff())(
  "T1.7 approval gate e2e: real pause (register → real teardown → promote) → status awaiting-approval → operator approves over stdin",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t17");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    let keyWasMinted = false;
    let pauseSucceeded = false;
    let store: InstanceType<typeof RunRecordStore> | undefined;
    let ledger: InstanceType<typeof CostLedger> | undefined;
    const hashesBefore = await listedKeyHashes();
    try {
      workspace = tmpWorkspace("t17");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // Beside the records dir (costLedgerOpts). Without it the close step
      // fail-louds `box-hour-rate-unconfigured`; $0.23/hr mirrors exe.dev's
      // 2CPU/8GiB rate, as T1.4 already established.
      writeFileSync(join(workspace, "cost-config.json"), JSON.stringify({ boxHourRateMicroUsd: 230_000 }));

      // ── the allowlist: REAL file, mode 0600, hashed with the ONE formula the
      //    factory verifies against (never a hand-computed digest) ────────────
      const factoryDir = join(workspace, ".factory");
      mkdirSync(factoryDir, { recursive: true, mode: 0o700 });
      chmodSync(factoryDir, 0o700);
      const allowlistPath = join(factoryDir, "approvers.json");
      writeFileSync(
        allowlistPath,
        JSON.stringify({
          version: 1,
          approvers: { [APPROVER_ID]: { salt: APPROVER_SALT, hash: hashToken(APPROVER_SALT, APPROVER_TOKEN) } },
        }),
      );
      // writeFileSync's mode option is umask-masked; chmod after is the only
      // form that lands 0600, and the allowlist reader refuses anything wider.
      chmodSync(allowlistPath, 0o600);
      expect(statSync(allowlistPath).mode & 0o777).toBe(0o600);
      expect(statSync(factoryDir).mode & 0o777).toBe(0o700);
      const tokenPath = join(workspace, "approver.token");
      writeFileSync(tokenPath, `${APPROVER_TOKEN}\n`);
      chmodSync(tokenPath, 0o600);

      // ── a REAL run: record → real box → real capped key ────────────────────
      store = new RunRecordStore({ dir: recordsDir });
      store.create(runId);
      const vm = (await ctx.driver.create(runId)).name;
      store.set(runId, {
        vmName: vm,
        extensions: {
          budget: {
            repoSlug: "e2e-private/test",
            issueId: "1",
            capMicroUsd: 5000,
            spentMicroUsd: 0,
            reservedMicroUsd: 0,
            admittedCeilingMicroUsd: 5000,
          },
        },
      });
      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
      keyWasMinted = true;
      evidence.push({ phase: "provision", ok: true, vm, keyHash: hash });
      expect(hashesBefore.has(hash)).toBeFalse();
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeTrue();

      // ── AC1: pause. The teardown dep is the REAL one, wrapped only to record
      //    the state it OBSERVES — a teardown-before-registration implementation
      //    sees `undefined` here and fails on the order assertion alone ───────
      const order: string[] = [];
      ledger = new CostLedger({
        ...costLedgerOpts(store.dir),
        runsDir: store.dir,
        // The CLI's shape: only a genuinely missing record reads as undefined,
        // so the ledger's orphan cross-check cannot throw mid-teardown.
        readRunRecord: (id: string) => {
          try {
            return (store as RunRecordStore).get(id);
          } catch (e) {
            if ((e as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined;
            throw e;
          }
        },
      });
      const tdeps = {
        driver: ctx.driver,
        store,
        keyApi: openRouterKeyApi(),
        costLedger: ledger,
        gitCwd: REPO_ROOT,
        runsDir: store.dir,
      };
      // The report this pause binds to. `headSha` is the REAL pinned SHA — the
      // first 40-hex validation in the repo runs against a real commit id.
      const reportId = `rv-${runId}`;
      const reportCompletedAt = new Date().toISOString();
      const pause = await requestApproval(
        {
          store,
          teardown: async (id, opts) => {
            order.push(`teardown-start:${String(store?.get(id).extensions?.approval?.state)}`);
            await teardownSandbox(tdeps, id, opts);
            order.push("teardown-done");
          },
        },
        runId,
        { proposal: `open a PR for run ${runId}`, reportId, headSha: ctx.sha },
      );
      pauseSucceeded = true;
      evidence.push({ phase: "pause", outcome: pause, order });

      expect(pause).toEqual({ outcome: "requested" });
      // THE ORDER CLAIM, against real infrastructure: `pausing` was on disk
      // before the box was destroyed and the key revoked.
      expect(order).toEqual(["teardown-start:pausing", "teardown-done"]);

      // ── the teardown was REAL: box gone, key revoked and verified gone ─────
      expect((await ctx.driver.list(runId)).some((b) => b.name === runId)).toBeFalse();
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeFalse();
      const paused = store.get(runId);
      expect(paused.closedAt).toBeDefined();
      expect(paused.extensions?.approval?.state).toBe("awaiting-approval");
      expect(paused.extensions?.approval?.reportId).toBe(reportId);
      expect(paused.extensions?.approval?.headSha).toBe(ctx.sha);
      evidence.push({ phase: "post-pause-record", closedAt: paused.closedAt, approval: paused.extensions?.approval });

      // ── AC7: the box is GENUINELY absent, and the row still says paused ────
      const status = await runFleet(["status", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 120_000 });
      evidence.push({ phase: "status", exitCode: status.exitCode, stdout: status.stdout.trim().slice(0, 600) });
      expect(status.exitCode).toBe(0);
      const row = lastJson<{ runId?: string; state?: string; reportId?: string; expiresInMs?: number }>(status.stdout);
      expect(row.runId).toBe(runId);
      // NOT boxMissing — that is the whole of AC7, and it is only meaningful
      // because the box really is gone (asserted above against driver.list()).
      expect(row.state).toBe("awaiting-approval");
      expect(row.reportId).toBe(reportId);
      expect(row.expiresInMs).toBeGreaterThan(0);

      // ── AC5: a paused run takes no steering — its box is gone ─────────────
      const attach = await runFleet(
        ["attach", runId, "--driver", "exedev", "--message", "steer left", "--dir", recordsDir],
        { timeoutMs: 120_000, env: { QDS_STEERING_ROOT: join(workspace, "steering") } },
      );
      evidence.push({ phase: "attach-refusal", exitCode: attach.exitCode, stderr: attach.stderr.trim().slice(-1200) });
      expect(attach.exitCode).toBe(5);
      expect(envelope(attach.stderr, "run-not-attachable")).toMatchObject({ state: "awaiting-approval" });

      // ── AC2/AC4: the operator approves, token on fd 0, cwd = the host root
      //    holding .factory/approvers.json ────────────────────────────────────
      const approve = await runFleetWithToken(
        ["approve", runId, "--approver", APPROVER_ID, "--reason", "e2e demo", "--dir", recordsDir],
        tokenPath,
        { cwd: workspace, timeoutMs: 120_000 },
      );
      evidence.push({
        phase: "approve",
        exitCode: approve.exitCode,
        stdout: approve.stdout.trim().slice(0, 600),
        stderr: approve.stderr.trim().slice(-1200),
      });
      expect(approve.exitCode).toBe(0);
      expect(lastJson<{ outcome?: string; state?: string }>(approve.stdout)).toMatchObject({
        outcome: "decided",
        state: "approved",
      });
      // The token must not survive anywhere in the subprocess's output.
      expect(approve.stdout + approve.stderr).not.toContain(APPROVER_TOKEN);

      // ── THE DoD ASSERTION, on the RECORD ──────────────────────────────────
      const decided = store.get(runId).extensions?.approval;
      evidence.push({ phase: "decided-record", approval: decided, reportCompletedAt });
      expect(decided?.state).toBe("approved");
      expect(decided?.approverId).toBe(APPROVER_ID);
      expect(typeof decided?.decidedAt).toBe("string");
      // DF5.2 refuses `approval-precedes-report` when the decision predates the
      // report it claims to authorize (push.ts:290-299). Both are host clocks.
      expect(Date.parse(String(decided?.decidedAt))).toBeGreaterThanOrEqual(Date.parse(reportCompletedAt));
      // …and the pair the PR will be bound to survived the decision intact.
      expect(decided?.reportId).toBe(reportId);
      expect(decided?.headSha).toBe(ctx.sha);

      // ── AC2 idempotency, live: a contradicting second decision returns the
      //    FIRST and changes nothing ──────────────────────────────────────────
      const before = store.get(runId);
      const second = await runFleetWithToken(
        ["reject", runId, "--approver", APPROVER_ID, "--reason", "second decision", "--dir", recordsDir],
        tokenPath,
        { cwd: workspace, timeoutMs: 120_000 },
      );
      evidence.push({ phase: "second-decision", exitCode: second.exitCode, stdout: second.stdout.trim().slice(0, 600) });
      // 0, not a refusal: "this run is decided" holds, and a refusal code would
      // send automation back to retry a decision that can never change.
      expect(second.exitCode).toBe(0);
      expect(lastJson<{ outcome?: string; state?: string; approverId?: string; reason?: string }>(second.stdout)).toMatchObject({
        outcome: "already-decided",
        state: "approved",
        approverId: APPROVER_ID,
        reason: "e2e demo",
      });
      expect(store.get(runId).extensions?.approval).toEqual(before.extensions?.approval);

      // ── round hygiene: no box of ours survives (skill: final-ls) ───────────
      // Presumes no concurrent live round, which the skill mandates anyway.
      const finalLs = await ctx.driver.list();
      evidence.push({ phase: "final-ls", boxes: finalLs.map((b) => b.name) });
      expect(finalLs.filter((b) => /^(e2e|qds)-/.test(b.name)).map((b) => b.name)).toEqual([]);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // The pause OWNS the destroy and the revoke, so these run only when it
      // did not complete — a mid-pause failure can leave a live box or a live
      // key, and neither may outlive this test.
      try {
        if (!pauseSucceeded && (await ctx.driver.list(runId)).some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-destroy", ok: true });
        }
      } catch {
        // a list/destroy failure must not mask the test's own result
      }
      if (!pauseSucceeded && keyWasMinted && store !== undefined) {
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      try {
        ledger?.close();
      } catch (e) {
        evidence.push({ phase: "finally-ledger-close", ok: false, error: (e as Error).message });
      }
      // The comparison the skill requires: no key hash we minted may outlive us.
      try {
        const after = await listedKeyHashes();
        evidence.push({
          phase: "key-hash-delta",
          leaked: [...after].filter((h) => !hashesBefore.has(h)),
        });
      } catch (e) {
        evidence.push({ phase: "key-hash-delta", ok: false, error: (e as Error).message });
      }
      try {
        evidencePath = writeEvidence("t1-7-approval-gate", { test: "T1.7", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.7] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  900_000,
);
