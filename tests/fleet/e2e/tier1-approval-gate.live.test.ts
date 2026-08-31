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
import { scryptToken, SCRYPT_PARAMS } from "../../../src/fleet/approvers.ts";
import { CostLedger, openRouterKeyApi, teardownSandbox } from "../../../src/providers/index.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
import { costLedgerOpts } from "../../../scripts/lib/cost-ledger-opts.ts";
import {
  REPO_ROOT,
  ledgerRows,
  listedKeyHashes,
  liveGate,
  liveTodoOff,
  mintCappedKey,
  preflight,
  revokeQuietly,
  runFleet,
  runFleetWithToken,
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
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        // An interleaved or truncated `{`-prefixed line is noise; a parse throw
        // at the wrong site would replace the refusal assertion being checked.
        return [];
      }
    })
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
    /** The body's own error, held so the leak verdict below runs on the failing path too. */
    let failure: unknown;
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
    // NOTE: `hashesBefore` → `leaked` is a WHOLE-ACCOUNT delta, not a per-run
    // one — a key minted concurrently by another live test in this window
    // reads as a leak here. Same serial-round presumption the final-ls check
    // below carries ("presumes no concurrent round"); the skill mandates one
    // live round at a time, and per-file runs are the invocation pattern.
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
          approvers: {
            [APPROVER_ID]: {
              v: 2,
              salt: APPROVER_SALT,
              hash: scryptToken(APPROVER_SALT, APPROVER_TOKEN),
              ...SCRYPT_PARAMS,
            },
          },
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
      // Asserted like its neighbours: the token is what authenticates the
      // decision, and writeFileSync's mode is umask-masked — a regression that
      // leaves it world-readable must fail here, not pass.
      expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

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
      // Set BEFORE the await: `mintRunKey` creates the key at the provider and
      // only THEN stamps `keyHash` onto the record and validates the cap echo
      // (credentials.ts) — a throw in that tail leaves a LIVE billable key
      // behind a false flag. The optimistic flag is safe: `revokeQuietly`
      // returns "none" with no API call when the record carries no keyHash.
      keyWasMinted = true;
      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
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
      // STRICTLY positive, not `>= 0`: a record write is a SQLite commit, which
      // cannot take 0 ms on a real clock. `>= 0` accepted a field that stopped
      // being measured at all (a `0` emitted unconditionally reads as "the
      // write was free") — the same tautology `teardown_at_pause_ms` above
      // refuses, and the D8 pause below repeats.
      expect(Number(pauseEvent?.record_write_ms)).toBeGreaterThan(0);
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

      // ── the pause's real teardown left a PRICED ledger row. A real
      //    CostLedger rides the teardown seam above (so the close step cannot
      //    fail-loud `box-hour-rate-unconfigured`), and until now nothing in
      //    this file ever read it back — a ledger that silently wrote nothing,
      //    or wrote the hours UNPRICED, would have passed the whole file. Read
      //    through the harness's readonly handle with T1.4's query: the row is
      //    committed by `ingestBoxHours` during the teardown, before the
      //    finally closes this process's connection. ────────────────────────
      const ledgerForRun = ledgerRows<{ run_id: string; kind: string; cost_micro_usd: number; unpriced: number }>(
        store.dir,
        "SELECT run_id, kind, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ?",
        runId,
      );
      evidence.push({ phase: "ledger-rows", rows: ledgerForRun });
      expect(ledgerForRun.length).toBeGreaterThanOrEqual(1);
      // Only box-hours can exist for this run: no chat call ever references the
      // minted key, so there is no `tokens` row to mix in — a `tokens` row here
      // would mean the key WAS used, which is its own leak.
      expect(ledgerForRun.every((r) => r.kind === "box_hours")).toBeTrue();
      // PRICED, both halves: `unpriced` is 0, and the cost is strictly positive
      // — the close rounds a sub-µ$ lifetime UP to 1 µ$ (cost-ledger F8), so a
      // real box that really existed can never price at 0.
      expect(ledgerForRun.every((r) => r.unpriced === 0)).toBeTrue();
      expect(ledgerForRun.every((r) => r.cost_micro_usd > 0)).toBeTrue();

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
      // Secret-absence is asserted BEFORE the phase enters the evidence
      // artifact: the finally writes evidence on a failing run too, so a
      // push-then-assert order would commit the token to disk before the red
      // line fired. If this assertion fails, the raw output is exactly the
      // thing that must not be written.
      expect(approve.stdout + approve.stderr).not.toContain(APPROVER_TOKEN);
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

      // ── the exit table's "auth refusal 5" row, LIVE: a WRONG token against
      //    the one allowlisted identity. Real scrypt verify, real constant-time
      //    compare, the `approver-token-mismatch` refusal — the half of AC4 the
      //    happy leg cannot reach, because every live approve above proves the
      //    accepted arm only. ZERO spend: the scrypt verify fails before
      //    `submitDecision` is ever called, so the record is untouched ──────
      const wrongTokenPath = join(workspace, "wrong.token");
      writeFileSync(wrongTokenPath, `${APPROVER_TOKEN}-not-it\n`);
      chmodSync(wrongTokenPath, 0o600);
      const beforeRefusal = store.get(runId).extensions?.approval;
      const refused = await runFleetWithToken(
        ["approve", runId, "--approver", APPROVER_ID, "--reason", "wrong token leg", "--dir", recordsDir],
        wrongTokenPath,
        { cwd: workspace, timeoutMs: 120_000 },
      );
      // Assert-before-record, as on the happy leg above: this phase's raw
      // stderr must not be serialized into evidence while an unasserted
      // token could still be sitting in it.
      expect(refused.stdout + refused.stderr).not.toContain(APPROVER_TOKEN);
      expect(refused.stdout + refused.stderr).not.toContain(`${APPROVER_TOKEN}-not-it`);
      evidence.push({
        phase: "approve-auth-refused",
        exitCode: refused.exitCode,
        stderrTail: refused.stderr.trim().slice(-600),
      });
      expect(refused.exitCode).toBe(5);
      // The refusal envelope names the mismatch guard; the assertions above
      // already cleared both tokens from every byte this phase produced.
      const refusal = envelope(refused.stderr, "approver-token-mismatch");
      expect(refusal).toBeDefined();
      expect(JSON.stringify(refusal)).not.toContain(`${APPROVER_TOKEN}-not-it`);
      // Nothing was mutated: the record still carries the happy leg's decision.
      expect(store.get(runId).extensions?.approval).toEqual(beforeRefusal);

      // ── THE DoD ASSERTION, on the RECORD ──────────────────────────────────
      const decided = store.get(runId).extensions?.approval;
      evidence.push({ phase: "decided-record", approval: decided, reportCompletedAt });
      expect(decided?.state).toBe("approved");
      expect(decided?.approverId).toBe(APPROVER_ID);
      expect(typeof decided?.decidedAt).toBe("string");
      // NOT asserted: `decidedAt >= reportCompletedAt`. The subprocess decided
      // minutes AFTER this process captured that timestamp, so the comparison
      // is true by construction — coverage-shaped, it would stay green through
      // a regression in DF5.2's `approval-precedes-report` guard. That guard
      // (push.ts) is pinned where it is actually testable without live spend:
      // tests/pr/open-pr.test.ts, "an approval decided BEFORE the report it
      // would authorize refuses".
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
      // Asserted on EVERY token-bearing invocation, not just the first: the
      // already-decided path is a different route through the CLI's echo and
      // error formatting, its stdout is what lands in the committed evidence
      // JSON, and the harness scrubber only strips `sk-…` and the provisioning
      // key — an approver token matches neither pattern. Asserted BEFORE the
      // phase enters evidence, as on the legs above.
      expect(second.stdout + second.stderr).not.toContain(APPROVER_TOKEN);
      evidence.push({
        phase: "second-decision",
        exitCode: second.exitCode,
        stdout: second.stdout.trim().slice(0, 600),
        stderr: second.stderr.trim().slice(-1200),
      });
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
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
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
      } catch (e) {
        // a list/destroy failure must not mask the test's own result, but the
        // attempt must not vanish either — a box destroyed by nobody on a red
        // run has to look different in the artifact from a clean sweep.
        evidence.push({ phase: "finally-destroy", ok: false, error: (e as Error).message });
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
      } catch (e) {
        // D6's ratified pattern: an evidence-write throw must not replace the
        // test's real failure — nor skip the workspace cleanup, which is why
        // the rmSync below lives in a `finally` of its own.
        process.stderr.write(`[T1.7] evidence write failed: ${(e as Error).message}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }

    // The key-leak verdict is the run's LAST claim, on EVERY path: a red run is
    // the run whose key is most likely to have survived it, so an actually-
    // leaked population must produce a second red line naming the leak — not
    // ride inside one failure's message, never rendered. `failure` is
    // re-thrown AFTER this, so the verdict cannot mask the body's own error
    // and the body's error cannot skip the verdict.
    //
    // The "could not look" arm is asserted FIRST and separately. `leaked` is
    // `[]` both when nothing leaked and when the listing threw, so asserting it
    // alone cannot tell a clean run from an unmeasured one — and D6 exists
    // precisely because an unmeasured key population was reading as a clean one.
    expect(deltaError).toBeUndefined();
    expect(leaked).toEqual([]);
    if (failure !== undefined) throw failure;
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
    /** The body's own error, held so the post-finally leak verdict below runs on the failing path too. */
    let failure: unknown;
    /** The hash minted in the body; the finally's delta compares against it. */
    let d8Hash = "";
    /** Hoisted for the post-finally leak verdict (the T1.7 shape). */
    let d8Leaked: string[] = [];
    let d8DeltaError: string | undefined;
    let store: InstanceType<typeof RunRecordStore> | undefined;
    const entries: Record<string, unknown>[] = [];
    // The account baseline the finally's delta falls back to when the mint
    // threw BEFORE a hash was known (E7). Snapshotted here, where a throw costs
    // nothing (no box, no key exists yet), rather than inside the `finally`.
    const hashesBefore = await listedKeyHashes();
    try {
      workspace = tmpWorkspace("d8");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // Without a box-hour rate the close step fail-louds `box-hour-rate-unconfigured`.
      writeFileSync(join(workspace, "cost-config.json"), JSON.stringify({ boxHourRateMicroUsd: 230_000 }));

      store = new RunRecordStore({ dir: recordsDir });
      store.create(runId);
      const vm = (await ctx.driver.create(runId)).name;
      // The POSITIVE control for the box-gone premise below (T1.7's shape): the
      // only other `list()` in this test is the post-teardown absence check, so
      // "the box is gone" must first be distinguishable from "this driver never
      // lists a box of this shape". The box we create IS the run id — the
      // teardown and the absence check both address it by that name.
      expect(vm).toBe(runId);
      expect((await ctx.driver.list(runId)).some((b) => b.name === runId)).toBeTrue();
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

      // Set BEFORE the await (T1.7's rationale): the mint's tail (record stamp,
      // cap validation) can throw after the provider has already created a LIVE
      // key, and a flag left false there means the finally revokes nothing.
      keyWasMinted = true;
      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
      d8Hash = hash;
      evidence.push({ phase: "mint", ok: true, keyHash: hash });

      // ── DF2.5 tears the box down, as it really does, BEFORE any reverify ──
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 420_000 });
      evidence.push({ phase: "df2.5-teardown", exitCode: td.exitCode, stderrTail: td.stderr.trim().slice(-4000) });
      expect(td.exitCode).toBe(0);

      // ── the teardown PRICED the box, in the ledger the subprocess wrote. The
      //    cost config beside the records dir is what makes the close step
      //    price instead of fail-loud, and until now nothing read the row back
      //    — a teardown that closed the record but wrote an unpriced or empty
      //    ledger would have passed this test. T1.7's pause leg pins the same
      //    row against the in-process ledger; this is the subprocess half.
      const ledgerForRun = ledgerRows<{ run_id: string; kind: string; cost_micro_usd: number; unpriced: number }>(
        recordsDir,
        "SELECT run_id, kind, cost_micro_usd, unpriced FROM cost_events WHERE run_id = ?",
        runId,
      );
      evidence.push({ phase: "ledger-rows", rows: ledgerForRun });
      expect(ledgerForRun.length).toBeGreaterThanOrEqual(1);
      expect(ledgerForRun.every((r) => r.kind === "box_hours")).toBeTrue();
      // PRICED, both halves (cost-ledger F8 rounds a sub-µ$ lifetime UP, so a
      // real box that really existed can never price at 0).
      expect(ledgerForRun.every((r) => r.unpriced === 0)).toBeTrue();
      expect(ledgerForRun.every((r) => r.cost_micro_usd > 0)).toBeTrue();

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
      // signal rather than an emitter that emits nothing. Strictly positive —
      // a committed SQLite write cannot take 0 ms, so `>= 0` would accept a
      // timer that stopped being wired up (T1.7's pause asserts the same).
      expect(Number(pauseEvent?.record_write_ms)).toBeGreaterThan(0);
    } catch (e) {
      outcome = "fail";
      // HELD, not thrown (T1.7's shape): a `throw` here makes the finally's
      // leak verdict unreachable on exactly the runs where it matters most —
      // the red runs are the runs whose key is most likely to have survived.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-direct-destroy", ok: true });
        }
      } catch (e) {
        // a list/destroy failure must not mask the test's own result, but a
        // box destroyed by nobody has to look different in the artifact from
        // a clean sweep.
        evidence.push({ phase: "finally-direct-destroy", ok: false, error: (e as Error).message });
      }
      // UNCONDITIONAL on `teardownSucceeded`: a teardown that exits 0 without
      // revoking is exactly the product defect this test exists to catch, and
      // gating the fallback on the exit code trusts the very chain under test
      // to have cleaned up after itself. `revokeQuietly` of an already-revoked
      // key answers "already-gone" (harmless), while a skipped one leaves the
      // key live with cleanup left to a human reading evidence.
      //
      // Wrapped exactly like T1.7's identical call above: `revokeQuietly` reads
      // the record OUTSIDE its own try, so on the path this finally exists for
      // — the teardown FAILED, quite possibly before writing a readable record
      // — the read throws, escapes the `finally`, skips the evidence write and
      // the workspace rmSync, and replaces the test's real error with a
      // record-read one on the run that most needs the forensic trail.
      if (keyWasMinted && store !== undefined) {
        try {
          await revokeQuietly(ctx.driver, store, runId, evidence);
        } catch (e) {
          evidence.push({ phase: "finally-revoke", ok: false, error: (e as Error).message });
        }
      }
      // The same leak comparison T1.7 and T5.1 render: the minted hash must be
      // absent from the provider's list, and a listing that cannot be
      // enumerated is a verdict that was never rendered — recorded, not
      // swallowed, so the assertion below cannot read "could not look" as
      // "nothing leaked".
      try {
        const after = await listedKeyHashes();
        // Per-run filter while the mint's hash is known. When it is NOT — the
        // mint threw after the provider created the LIVE key but before its
        // tail stamped `keyHash` anywhere, leaving `d8Hash === ""` — the
        // `h === ""` filter is satisfied by every listing for free, and the
        // one key this run may have stranded reads as "nothing leaked". Fall
        // back to the whole-account delta against `hashesBefore` so the red
        // path still renders a verdict grounded in a real population. (Same
        // serial-round presumption T1.7's NOTE states: a key minted by another
        // live test in this window would surface here too.)
        d8Leaked =
          d8Hash === ""
            ? [...after].filter((h) => !hashesBefore.has(h))
            : [...after].filter((h) => h === d8Hash);
        evidence.push({ phase: "key-hash-delta", leaked: d8Leaked, basis: d8Hash === "" ? "account-delta" : "minted-hash" });
      } catch (e) {
        d8DeltaError = (e as Error).message;
        evidence.push({ phase: "key-hash-delta", ok: false, error: d8DeltaError });
      }
      try {
        const p = writeEvidence("d8-shipped-port-gate", { test: "D8", outcome, runId, phases: evidence });
        process.stderr.write(`[D8] evidence: ${p}\n`);
      } catch (e) {
        // D6's ratified pattern: an evidence-write throw must not replace the
        // test's real failure — nor skip the workspace cleanup below.
        process.stderr.write(`[D8] evidence write failed: ${(e as Error).message}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }

    // Mirror of T1.7's post-finally verdict, outside the finally so a throw
    // cannot overwrite the test's own failure (biome/noUnsafeFinally). Reached
    // on the RED path too, because the catch above HELDS the body's error
    // instead of throwing it — the leaked-key check below is only as good as
    // its reachability, and the failing run is the run whose key is most
    // likely to have survived.
    expect(d8DeltaError).toBeUndefined();
    expect(d8Leaked).toEqual([]);
    // The finally's revoke entry is a verdict, not prose: `revokeQuietly`
    // records `ok:false` when the revoke threw, and an unread evidence line
    // would read as a clean run. Consumed here, where the finally's own writes
    // are complete and a throw cannot mask the held body error (which is
    // re-thrown last).
    const revokeFailures = evidence.filter((p) => p.phase === "finally-revoke" && p.ok === false);
    expect(revokeFailures).toEqual([]);
    if (failure !== undefined) throw failure;
  },
  // 900 s, not 600 s: the teardown leg alone may consume 420 s, and a runner
  // kill at 600 s aborts the `finally` — losing the evidence write, the box
  // destroy and the key revoke on the slowest (most leak-prone) runs. T1.7's
  // budget for the same leg mix.
  900_000,
);
