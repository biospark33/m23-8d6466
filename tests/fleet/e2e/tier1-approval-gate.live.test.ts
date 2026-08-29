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
import { recordApprovalPort } from "../../../src/reverify/approval.ts";
import { hashToken } from "../../../src/fleet/approvers.ts";
import { CostLedger, openRouterKeyApi, teardownSandbox } from "../../../src/providers/index.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
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
 * The run's dispatch correlation id — a strict UUID v4, the shape
 * `resolveBriefRequestId` accepts and `fleet dispatch` persists onto the record.
 * It is the JOIN KEY: the `pause` gate event is emitted in THIS process by the
 * gate library, the `approve` gate event is emitted in a SEPARATE `fleet
 * approve` subprocess, and this id is the only value both can carry.
 */
const DISPATCH_REQUEST_ID = "3f2a1c7e-9b4d-4e2a-8f61-0c5d7a9b1e34";

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

/**
 * The structured gate-event line a verb wrote, by `event`.
 *
 * STDERR, not stdout: `scripts/fleet.ts` installs its own log sink routing the
 * JSONL stream to fd 2, so fd 1 carries only the verb's OUTPUT (the completion
 * line `lastJson` reads). The first live run of this assertion read stdout and
 * found nothing while the line sat in stderr all along — the evidence file for
 * that run shows it on both the attach and approve phases.
 *
 * No `QDS_LOG_VERBOSE` is needed and none is set: a custom sink bypasses
 * `logMuted()` entirely, so what this parses is what an operator sees with no
 * environment tuning at all.
 */
function gateLine(stdout: string, event: string): Record<string, unknown> | undefined {
  return stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .find((l) => l.event === event);
}

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
    /**
     * The teardown's own trace, declared OUT here because `finally` reads it.
     * `requestApproval` RETURNING proves nothing about cleanup: every non-fresh
     * outcome (`pause-in-progress`, `already-decided`, `rebound`) returns before
     * `deps.teardown` is ever called, so a flag set on the call's return would
     * claim the pause owned the destroy and the revoke on exactly the runs where
     * it did not — leaking a real box and a real billable key.
     */
    const order: string[] = [];
    /** Key hashes that appeared during this run and survived cleanup (asserted below the `finally`). */
    let leaked: string[] = [];
    /** Set when the delta LISTING itself failed — a verdict was never rendered. */
    let deltaError: string | undefined;
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
      // The POSITIVE CONTROL for AC7. Without it the only `list()` in this test
      // is the post-teardown one, and "the box is gone" is indistinguishable
      // from "this driver never lists a box of this shape" —
      // `listWithAnomalies` EXCLUDES rows outside the factory name grammar, so
      // a name-shape or ls-filter change would make the AC7 assertion below
      // permanently, silently true. Both must hold: the box we created is the
      // run id (the teardown and the AC7 check both address it by that name),
      // and a live box of that name IS visible to `list()`.
      expect(vm).toBe(runId);
      expect((await ctx.driver.list(runId)).some((b) => b.name === runId)).toBeTrue();
      store.set(runId, {
        vmName: vm,
        // What `fleet dispatch` stamps at dispatch.ts's `store.set(runId,
        // {requestId})`. This test builds the record by hand (it provisions
        // through the driver directly rather than through the dispatch verb),
        // so the field has to be written here or the record is LESS like
        // production than it should be — and the cross-process join this test
        // now proves would have nothing to join on.
        requestId: DISPATCH_REQUEST_ID,
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
      // `hashesBefore.has(hash)` was asserted here and could not fail short of a
      // sha collision — a fresh provider-side hash is absent from a set
      // snapshotted before the mint by construction. The check that CAN fail is
      // the one below (the key really exists at the provider), which is also the
      // only thing that makes the post-teardown absence check meaningful.
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeTrue();

      // ── AC1: pause. The teardown dep is the REAL one, wrapped only to record
      //    the state it OBSERVES — a teardown-before-registration implementation
      //    sees `undefined` here and fails on the order assertion alone ───────
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
      // The REAL sink, captured for the duration of the pause (D1). `setLogSink`
      // replaces the sink outright, so it also bypasses the NODE_ENV=test mute
      // — what lands in `pauseLines` is the line the gate actually writes, not
      // a shape this test invented. Restored in a `finally` so a throw here
      // cannot leave the suite's sink swapped.
      const pauseLines: Record<string, unknown>[] = [];
      const restoreSink = setLogSink((e) => void pauseLines.push(e as unknown as Record<string, unknown>));
      let pause: Awaited<ReturnType<typeof requestApproval>>;
      try {
        pause = await requestApproval(
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
      } finally {
        restoreSink();
      }
      const pauseEvent = pauseLines.find((l) => l.event === "pause");
      evidence.push({ phase: "pause", outcome: pause, order, pauseEvent });

      expect(pause).toEqual({ outcome: "requested" });
      // THE ORDER CLAIM, against real infrastructure: `pausing` was on disk
      // before the box was destroyed and the key revoked.
      expect(order).toEqual(["teardown-start:pausing", "teardown-done"]);

      // ── D1: the `pause` gate event, emitted for the first time on a real
      //    pause over a real box. The union in scripts/fleet.ts has declared
      //    this event since the story shipped and nothing produced it, so DF5.3
      //    had no line to join the approval against ──────────────────────────
      expect(pauseEvent).toBeDefined();
      expect(pauseEvent).toMatchObject({
        operation: "fleet.pause",
        event: "pause",
        runId,
        state: "awaiting-approval",
        outcome: "requested",
        status: "ok",
        requestId: DISPATCH_REQUEST_ID,
        dispatchRequestId: DISPATCH_REQUEST_ID,
      });
      // `teardown_at_pause_ms` is present HERE and only here: this leg passes a
      // real teardown seam, so there is a real destroy + revoke to measure. The
      // shipped reverify caller passes none (its box is already gone — deferred
      // item D8), and the field is absent there rather than zero.
      expect(Number(pauseEvent?.teardown_at_pause_ms)).toBeGreaterThan(0);
      expect(Number(pauseEvent?.record_write_ms)).toBeGreaterThanOrEqual(0);
      // No secret of any kind reached the line — the same property `writeEvidence`
      // enforces over the whole file, asserted here on the one line D1 adds.
      expect(JSON.stringify(pauseEvent)).not.toContain(APPROVER_TOKEN);
      expect(JSON.stringify(pauseEvent)).not.toContain("sk-or-");

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
      const approveEvent = gateLine(approve.stderr, "approve");
      evidence.push({
        phase: "approve",
        exitCode: approve.exitCode,
        approveEvent,
        stdout: approve.stdout.trim().slice(0, 600),
        stderr: approve.stderr.trim().slice(-1200),
      });
      expect(approve.exitCode).toBe(0);
      // ── D1: THE JOIN, across two processes. The pause was emitted by the gate
      //    library in THIS process; this line was emitted by a separate `fleet
      //    approve` subprocess whose own `requestId` is a fresh per-invocation
      //    id. `dispatchRequestId` is the only key that can be equal on both,
      //    and DF5.3's approval join is specified over exactly this pair ──────
      expect(approveEvent).toMatchObject({
        event: "approve",
        runId,
        outcome: "decided",
        state: "approved",
        dispatchRequestId: DISPATCH_REQUEST_ID,
      });
      expect(approveEvent?.dispatchRequestId).toBe(pauseEvent?.dispatchRequestId as string);
      // …and the NEGATIVE half, which is the whole reason the join needs its own
      // key: the two invocations' own `requestId`s are genuinely different, so a
      // consumer joining on `requestId` would find nothing.
      expect(approveEvent?.requestId).not.toBe(pauseEvent?.requestId as string);
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
      evidence.push({
        phase: "second-decision",
        exitCode: second.exitCode,
        stdout: second.stdout.trim().slice(0, 600),
        stderr: second.stderr.trim().slice(-1200),
      });
      // Asserted on EVERY token-bearing invocation, not just the first: the
      // already-decided path is a different route through the CLI's echo and
      // error formatting, its stdout is what lands in the committed evidence
      // JSON, and the harness scrubber only strips `sk-…` and the provisioning
      // key — an approver token matches neither pattern.
      expect(second.stdout + second.stderr).not.toContain(APPROVER_TOKEN);
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
      // FAIL SAFE, both arms. The pause owns the destroy and the revoke ONLY on
      // the path that actually reached `deps.teardown`; `order` carries that
      // fact and is recorded, but neither cleanup is GATED on it — a redundant
      // destroy of a box that is already gone is free (the list check below
      // skips it) and a redundant revoke of an already-revoked hash answers 404
      // "already-gone", while a skipped one leaves a real box running and a real
      // key billable on exactly the run nobody trusts to have cleaned up.
      evidence.push({ phase: "finally-teardown-ran", tornDown: order.includes("teardown-done"), order });
      try {
        if ((await ctx.driver.list(runId)).some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-destroy", ok: true });
        }
      } catch {
        // a list/destroy failure must not mask the test's own result
      }
      if (keyWasMinted && store !== undefined) {
        // `revokeQuietly` reads the record OUTSIDE its own try (live-harness.ts
        // :355), so a missing or malformed record throws straight out of this
        // `finally` — killing the ledger close, the evidence write and the
        // workspace cleanup, and replacing the test's real error with a
        // record-read one, on the run that most needs the forensic trail.
        try {
          await revokeQuietly(ctx.driver, store, runId, evidence);
        } catch (e) {
          evidence.push({ phase: "finally-revoke", ok: false, error: (e as Error).message });
        }
      }
      try {
        ledger?.close();
      } catch (e) {
        evidence.push({ phase: "finally-ledger-close", ok: false, error: (e as Error).message });
      }
      // The comparison the skill requires: no key hash we minted may outlive us.
      try {
        const after = await listedKeyHashes();
        leaked = [...after].filter((h) => !hashesBefore.has(h));
        evidence.push({ phase: "key-hash-delta", leaked });
      } catch (e) {
        // RECORDED IN A VARIABLE, not only in the evidence file. `leaked` keeps
        // its initial `[]` when this fires, so `expect(leaked).toEqual([])`
        // below passed on the exact case D6 was filed for: `listedKeyHashes`
        // now THROWS on a truncated listing, and "we could not look" was being
        // reported as "nothing leaked". A verdict that cannot be computed is
        // not a clean verdict.
        deltaError = (e as Error).message;
        evidence.push({ phase: "key-hash-delta", ok: false, error: (e as Error).message });
      }
      try {
        evidencePath = writeEvidence("t1-7-approval-gate", { test: "T1.7", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.7] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }

    // A comparison whose result is only serialized is a log line, not a check.
    // OUTSIDE the `finally` deliberately: a throw in there would overwrite the
    // test's own failure (biome/noUnsafeFinally), and this line is reached only
    // when the body passed — a failing run already fails, and the evidence
    // written above carries the leak either way.
    // Failure prints the surviving hashes; revoke them by hand (the evidence
    // path was written to stderr from the `finally` above).
    //
    // The "could not look" arm is asserted FIRST and separately. `leaked` is
    // `[]` both when nothing leaked and when the listing threw, so asserting it
    // alone cannot tell a clean run from an unmeasured one — and D6 exists
    // precisely because an unmeasured key population was reading as a clean one.
    expect(deltaError).toBeUndefined();
    expect(leaked).toEqual([]);
  },
  900_000,
);

/**
 * D8 — the SHIPPED caller reaches the gate with its box ALREADY GONE.
 *
 * T1.7 above proves the gate when a real teardown seam IS passed: the box dies
 * at the gate and `teardown_at_pause_ms` measures it (8454 ms, live, 2026-08-29).
 * That is the synthetic caller. This is the other half, and it is the half AC1(b)
 * is actually about — the ONLY non-test caller of the gate in the repo is
 * `src/reverify/runner.ts`, which constructs its port as `recordApprovalPort(store)`
 * with NO options and therefore NO teardown seam.
 *
 * The question D8 was filed to settle is empirical: does ANY shipped caller reach
 * `requestApproval` holding a live box? If none does, AC1(b)'s three-step ordering
 * (register → teardown → promote) is VACUOUS on the shipped path and the honest
 * amendment is (a) — teardown is DF2.5's, and the gate's obligation is to REFUSE a
 * run that still owns a box.
 *
 * WHAT IS REAL HERE: a real exe.dev box, a real minted OpenRouter key, the real
 * `fleet teardown` verb as a subprocess running the full DF2.5 chain (spend
 * capture → artifacts → harvest → revoke → verify → destroy → close + priced
 * ledger row), a real run record on disk, and the real gate entered through the
 * real DF5.1 port constructed EXACTLY as `runner.ts` constructs it.
 *
 * WHAT IS NOT COVERED, stated rather than implied: `reverify()`'s own verdict
 * pipeline is not run, so this does not prove reverify produces a green report —
 * that is DF5.1's subject and it is not what D8 asks. What it proves is the
 * ORDERING claim: by the time the shipped port is invoked, DF2.5 has already
 * closed the record, and the gate neither tears anything down nor refuses.
 *
 * TIER-1: real boxes, ZERO model spend. The key is minted and revoked without a
 * single chat call ever referencing it.
 */
test.todoIf(liveTodoOff())(
  "D8: the shipped port (no teardown seam) reaches the gate AFTER DF2.5 — record closed, and NO teardown at the gate",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("d8");
    let workspace = "";
    let outcome = "pass";
    let keyWasMinted = false;
    let teardownSucceeded = false;
    let store: InstanceType<typeof RunRecordStore> | undefined;
    const entries: Record<string, unknown>[] = [];
    try {
      workspace = tmpWorkspace("d8");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // Without a box-hour rate the close step fail-louds `box-hour-rate-unconfigured`.
      writeFileSync(join(workspace, "cost-config.json"), JSON.stringify({ boxHourRateMicroUsd: 230_000 }));

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
      evidence.push({ phase: "provision", ok: true, vm });

      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
      keyWasMinted = true;
      evidence.push({ phase: "mint", ok: true, keyHash: hash });

      // ── DF2.5 tears the box down, as it really does, BEFORE any reverify ──
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 420_000 });
      teardownSucceeded = td.exitCode === 0;
      evidence.push({ phase: "df2.5-teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-4000) });
      expect(td.exitCode).toBe(0);

      // ── THE RECORD STATE AT GATE ENTRY. This is D8's literal question. ────
      const atGate = store.get(runId);
      evidence.push({
        phase: "record-at-gate-entry",
        vmName: atGate.vmName,
        closedAt: atGate.closedAt,
        keyHash: atGate.keyHash,
      });
      // `closedAt` set is the whole finding: the box is GONE before the gate is
      // ever entered on the shipped path, so the ordering AC1(b) specifies has
      // nothing left to order.
      expect(atGate.closedAt).toBeDefined();
      // The record still NAMES the box it used to own — which is why the
      // fail-closed guard has to test `closedAt`, not merely `vmName`.
      expect(atGate.vmName).toBe(vm);
      expect(atGate.keyHash).toBe(hash);
      // …and the box really is gone, not just marked gone.
      expect((await ctx.driver.list(runId)).some((b) => b.name === runId)).toBeFalse();
      expect(await listedKeyHashes().then((set) => set.has(hash))).toBeFalse();

      // ── the gate, through the SHIPPED port, built exactly as runner.ts does ─
      const restore = setLogSink((e) => void entries.push(e as unknown as Record<string, unknown>));
      let pause: Awaited<ReturnType<ReturnType<typeof recordApprovalPort>["requestApproval"]>>;
      try {
        // `recordApprovalPort(store)` — no opts, no teardown, no bundleDir.
        // Byte-identical to `src/reverify/runner.ts`'s construction.
        pause = await recordApprovalPort(store).requestApproval(runId, {
          proposal: `open a PR for run ${runId}`,
          reportId: `rv-${runId}`,
          headSha: "a".repeat(40),
        });
      } finally {
        restore();
      }
      evidence.push({ phase: "gate", outcome: pause.outcome });

      // It PROMOTED. The INV-APPROVE-6 guard did not fire, because the record is
      // closed — the guard refuses an OPEN record that still owns a vmName, and
      // this one is closed. A caller with no seam is safe here precisely because
      // DF2.5 already ran.
      expect(pause.outcome).toBe("requested");
      expect(store.get(runId).extensions?.approval?.state).toBe("awaiting-approval");

      // ── THE ASSERTION D8 TURNS ON ─────────────────────────────────────────
      const pauseEvent = entries.find((e) => e.event === "pause");
      evidence.push({ phase: "pause-event", event: pauseEvent });
      expect(pauseEvent).toBeDefined();
      expect(pauseEvent?.outcome).toBe("requested");
      expect(pauseEvent?.state).toBe("awaiting-approval");
      // ABSENT, not zero. `teardown_at_pause_ms` is emitted only when
      // `deps.teardown` actually ran; its absence here is the machine-checkable
      // form of "no teardown happened at the gate on the shipped path", and a `0`
      // would be a lie shaped exactly like an instantaneous teardown.
      expect(Object.hasOwn(pauseEvent as object, "teardown_at_pause_ms")).toBeFalse();
      // The pause still MEASURED its own work, so the absence above is a real
      // signal rather than an emitter that emits nothing.
      expect(Number(pauseEvent?.record_write_ms)).toBeGreaterThanOrEqual(0);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-direct-destroy", ok: true });
        }
      } catch {
        // a list failure must not mask the test's own result
      }
      if (!teardownSucceeded && keyWasMinted && store !== undefined) {
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      try {
        const p = writeEvidence("d8-shipped-port-gate", { test: "D8", outcome, runId, phases: evidence });
        process.stderr.write(`[D8] evidence: ${p}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
