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
import { CostLedger, harvestRun, openRouterKeyApi, teardownSandbox } from "../../../src/providers/index.ts";
import { RunRecordStore } from "../../../src/providers/run-record.ts";
import { setLogSink } from "../../../src/swarmclaw/log.ts";
import { costLedgerOpts } from "../../../scripts/lib/cost-ledger-opts.ts";
import {
  REPO_ROOT,
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
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
  settleRun,
  tmpWorkspace,
  writeEvidenceQuietly,
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
    // NOTE: `hashesBefore` → `keyProblems` is a WHOLE-ACCOUNT delta, not a
    // per-run one — a key minted concurrently by another live test in this
    // window reads as a leak here. Same serial-round presumption the final-ls
    // check below carries ("presumes no concurrent round"); the skill mandates
    // one live round at a time, and per-file runs are the invocation pattern.
    /** The F17 key verdict (revoke-then-report), rendered in the `finally`. */
    let keyProblems: string[] = [];
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    /**
     * Evidence-WRITE failures, kept OUT of `destroyFailures`: a secret-scrub
     * refusal is not a box that failed to die, and `fleetCleanupProblems`
     * renders that array as "cleanup failures: …".
     */
    const writeProblems: string[] = [];
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
      // UNDER THE RECORDS DIR, not the workspace root: DF3.4 round-9 C10
      // made `--dir` the allowlist ROOT for approve/reject (enrol parity —
      // scripts/fleet.ts "The allowlist root is the SAME one `fleet enrol
      // --dir` writes under"), and every decide call below passes
      // `--dir recordsDir`. This test was written against the pre-C10
      // cwd-resolution contract and first ran live after C10 on 2026-09-01,
      // where the verb refused `approver-allowlist-dir-mode` on a `.factory`
      // it was told to find under runs/ (evidence:
      // 2026-09-01-232035-t1-7-approval-gate.json).
      const factoryDir = join(recordsDir, ".factory");
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
        // The harvested bundle's base (INV-APPROVE-6, below): harvest bundles
        // the box's commits SINCE this SHA, and the decide verb refuses a run
        // whose bundle is absent — so the record must carry the real base.
        commitSha: ctx.sha,
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
      // ── a FILLED, HARVESTED run: what makes the pause DECIDABLE ──────────
      // DF3.4 round 6's INV-APPROVE-6 binds every decision to the run's
      // harvested bundle (`<runsDir>/<runId>.bundle`) — a run with no bundle
      // is undecidable BY DESIGN ("a report naming a run with no bundle is
      // bound to nothing", approval-gate.ts). The production order is
      // work → HARVEST → pause → approve: the pause's own teardown is TYPED
      // `{noHarvest: true}` (approval-gate.ts:849) because the bundle must
      // already exist before an approval can bind to it. So the demo does
      // what production does: fill, land one real commit, harvest the bundle,
      // THEN pause. First hit live 2026-09-01 (approve refused "its harvested
      // bundle is gone") — this test predated the invariant and had never run
      // live since it landed.
      await ctx.driver.fill(vm, { runId, repoUrl: ctx.repoUrl, commitSha: ctx.sha, workdir: "src" });
      const seedCommit = await ctx.driver.exec(vm, [
        "git", "-C", "src",
        "-c", "user.email=e2e@qds.test", "-c", "user.name=e2e",
        "commit", "--allow-empty", "-m", "e2e: bundle seed (INV-APPROVE-6 binds the decision to a harvested bundle)",
      ]);
      expect(seedCommit.exitCode).toBe(0);
      const harvest = await harvestRun(
        { driver: ctx.driver, store, gitCwd: REPO_ROOT, runsDir: store.dir, workdir: "src" },
        runId,
      );
      const bundlePath = join(recordsDir, `${runId}.bundle`);
      // The entry lands BEFORE the bundle is stat'd. `statSync` inside the
      // `push` argument threw while EVALUATING it on the one regression this
      // block was added to catch — a `harvestRun` that returns without writing
      // `<runId>.bundle` — so the `provision` entry never landed and the
      // operator read a bare ENOENT instead of `harvest.outcome`, the field
      // that names what harvest actually did.
      evidence.push({ phase: "provision", ok: true, vm, keyHash: hash, filled: true, harvest: harvest.outcome });
      // The bundle the approve below is BOUND to — present and non-empty, the
      // exact two shapes assertBundlePresent refuses.
      expect(harvest.outcome).toBe("harvested");
      const bundleBytes = statSync(bundlePath).size;
      evidence.push({ phase: "provision-bundle", ok: true, bundlePath, bundleBytes });
      expect(bundleBytes).toBeGreaterThan(0);
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
            // Production parity (INV-APPROVE-6): the pause-side bundle check
            // runs too, not only the decide verb's — a pause over a missing
            // bundle must refuse HERE, before the box is torn down.
            bundleDir: store.dir,
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

      // ── AC2/AC4: the operator approves, token on fd 0; the allowlist root
      //    is `--dir` (C10 parity), NOT the cwd ─────────────────────────────
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
        // The list-before-destroy stays (a box already torn down by the pause
        // is the expected case and a redundant destroy probe is not free), but
        // the destroy itself goes through the harness's `destroyQuietly`
        // (#189): it records, writes the stderr remediation, AND returns the
        // verdict this run accumulates — a record-only failure shipped a
        // green test on a box still billing.
        if ((await ctx.driver.list(runId)).some((b) => b.name === runId)) {
          const destroyed = await destroyQuietly(ctx.driver, runId, evidence);
          if (!destroyed.ok) destroyFailures.push(`${runId}: ${destroyed.error}`);
        }
      } catch (e) {
        // The LIST probe failed — the destroy was never attempted, which is
        // as assertable a leak as a failed destroy: it must not mask the
        // test's own result, and it must not vanish into evidence either.
        evidence.push({ phase: "finally-destroy", ok: false, error: (e as Error).message });
        destroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      if (keyWasMinted && store !== undefined) {
        // `revokeQuietly` never throws (#189) — an unreadable record lands as
        // a `finally-revoke ok:false` evidence entry instead of escaping this
        // `finally` and killing the ledger close and evidence write.
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      try {
        ledger?.close();
      } catch (e) {
        evidence.push({ phase: "finally-ledger-close", ok: false, error: (e as Error).message });
      }
      // The comparison the skill requires, through the shared F17 verdict: no
      // key hash we minted may outlive us. `keyLeakProblems` keeps both
      // properties the hand-rolled delta here already had — the whole-account
      // diff against `hashesBefore`, and "could not look" rendered as a problem
      // rather than as "nothing leaked" (D6) — and adds the half it lacked:
      // a survivor is REVOKED through the record-backed fallback and then
      // re-listed BEFORE being reported, so the operator reading the failure
      // finds the key already dead instead of a hash to go chase by hand.
      // Needing that fallback is still a failed round: needing it IS the defect.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        { driver: ctx.driver, store, runIds: [runId] },
        evidence,
      );
      // The absolute `e2e-|qds-` backstop, taken at CLEANUP time. This file's
      // own "round hygiene" final-ls is a BODY assertion (line ~576) and is
      // therefore skipped on precisely the runs that leak — a body that threw
      // never reaches it. `destroyQuietly` confirms the absence of the box it
      // was ASKED to destroy; only a listing can see one nobody named.
      //
      // Through `fleetLeftovers` (P127/P128/R4), which fixes the three things
      // the single-shot line here got wrong: it POLLS the measured 25 s+
      // substrate destroy lag before calling a leak a leak; it DESTROYS what
      // this run owns and re-lists, where the old block only observed and left
      // the box billing; and it scopes the failing verdict to this run's name,
      // so a box stranded by a previous round is a labelled warning instead of
      // a permanent red on every future run of this test.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11) — the same "must not replace the test's
      // real failure" posture the hand-rolled catch took, plus the half it
      // lacked: a write that FAILED (ENOSPC, or the secret-scrub refusal, which
      // is the case that matters) is now a reported problem, not a stderr line
      // nothing asserts on.
      writeEvidenceQuietly("T1.7", "t1-7-approval-gate", { test: "T1.7", outcome, runId, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // The cleanup verdict is the run's LAST claim, on EVERY path: a red run is
    // the run whose key is most likely to have survived it, so an actually-
    // leaked population must still be named.
    //
    // Through `settleRun`, not through a row of `expect`s. The shape this
    // replaces — `expect(deltaError)…; expect(leaked)…; expect(destroyFailures)…;
    // if (failure) throw failure;` — was correct on a green run and wrong on a
    // red one: when the body had already failed AND cleanup also failed, the
    // first `expect` threw its own AssertionError and the held approval-gate
    // regression was DISCARDED. The operator then reads "cleanup failures: …"
    // where the regression was, and pays for another live round to rediscover
    // it. `settleRun` attaches every problem to the held error and re-throws the
    // ORIGINAL; on a run that otherwise passed, a cleanup problem is still the
    // failure.
    //
    // The "could not look" arm is `keyLeakProblems`' own first line: a listing
    // that threw yields a problem, never an empty `leaked` array — D6 exists
    // precisely because an unmeasured key population was reading as a clean one.
    //
    // `fleetCleanupProblems` now gets a REAL second argument. The round-4
    // review reversed the earlier reading: `destroyQuietly`'s verdict does
    // carry "is the box I destroyed gone", but it says nothing about a box
    // nobody asked it to destroy, and this file's final-ls lives in the BODY,
    // where a red run never reaches it. The cleanup-time listing above is the
    // fail-safe answer — a leaked box that no listing looks for is the failure
    // mode, and `undefined` (the listing itself failed) is correctly a problem
    // rather than a pass.
    settleRun(failure, [
      // `evidence` as the third argument folds in any `finally-revoke ok:false`
      // entry — the belt-and-braces revoke above records its failure there, and
      // nothing in this test read it.
      ...fleetCleanupProblems(destroyFailures, finalBoxes, evidence),
      ...keyProblems,
      // The evidence write, reported as itself rather than laundered through
      // the box verdict.
      ...writeProblems,
    ]);
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
    /** Hoisted for the post-finally leak verdict (the T1.7 shape). */
    let d8KeyProblems: string[] = [];
    /** Destroys that FAILED (#189) — asserted AFTER the `finally`, never only recorded. */
    const d8DestroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let d8FinalBoxes: string[] | undefined;
    /** Evidence-WRITE failures, kept OUT of `d8DestroyFailures` (T1.7's reason). */
    const d8WriteProblems: string[] = [];
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
        // List-before-destroy preserved (the teardown verb usually got there
        // first); the destroy itself rides the harness's `destroyQuietly`
        // (#189) so the verdict is accumulated and asserted after the finally
        // — a record-only failure shipped a green test on a box still billing.
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          const destroyed = await destroyQuietly(ctx.driver, runId, evidence);
          if (!destroyed.ok) d8DestroyFailures.push(`${runId}: ${destroyed.error}`);
        }
      } catch (e) {
        // The LIST probe failed — the destroy was never attempted; that must
        // not mask the test's own result, and must not vanish into evidence.
        evidence.push({ phase: "finally-direct-destroy", ok: false, error: (e as Error).message });
        d8DestroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      // UNCONDITIONAL on `teardownSucceeded`: a teardown that exits 0 without
      // revoking is exactly the product defect this test exists to catch, and
      // gating the fallback on the exit code trusts the very chain under test
      // to have cleaned up after itself. `revokeQuietly` of an already-revoked
      // key answers "already-gone" (harmless), while a skipped one leaves the
      // key live with cleanup left to a human reading evidence. It never
      // throws (#189): on the path this finally exists for — the teardown
      // FAILED, quite possibly before writing a readable record — the
      // unreadable record lands as a `finally-revoke ok:false` verdict.
      if (keyWasMinted && store !== undefined) {
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      // The same leak comparison T1.7 and T5.1 render: the minted hash must be
      // absent from the provider's list, and a listing that cannot be
      // enumerated is a verdict that was never rendered — recorded, not
      // swallowed, so the assertion below cannot read "could not look" as
      // "nothing leaked".
      // Through the shared F17 verdict, which also DELETES this leg's sharpest
      // edge: the old code filtered `h === d8Hash` whenever the mint's hash was
      // known and fell back to the account delta only when it was not — two
      // bases, of which the narrow one is exactly the wrong choice on the path
      // that matters (a `mintRunKey` tail that threw can leave a LIVE key whose
      // hash this test never learned). `keyLeakProblems` always diffs the whole
      // account against `hashesBefore` — the strictly fail-safe basis — and
      // revokes any survivor through the record-backed fallback before
      // reporting it. Same serial-round presumption T1.7's NOTE states.
      d8KeyProblems = await keyLeakProblems(
        hashesBefore,
        { driver: ctx.driver, store, runIds: [runId] },
        evidence,
      );
      // The absolute `e2e-|qds-` backstop at CLEANUP time — every other
      // listing in this test is scoped to `runId`, so a box standing under any
      // other name was invisible to all of them.
      //
      // Through `fleetLeftovers` (P127/P128/R4): the poll absorbs the measured
      // 25 s+ destroy lag, a survivor this run owns is destroyed and re-listed
      // before any verdict, and a box left behind by an earlier round is warned
      // about rather than failing D8 for as long as it exists.
      d8FinalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11): same posture as the hand-rolled catch,
      // plus a REPORTED problem when the write itself fails.
      writeEvidenceQuietly("D8", "d8-shipped-port-gate", { test: "D8", outcome, runId, phases: evidence }, d8WriteProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // Mirror of T1.7's post-finally verdict, outside the finally so a throw
    // cannot overwrite the test's own failure (biome/noUnsafeFinally), and
    // through `settleRun` for the reason spelled out there: a row of `expect`s
    // ahead of `throw failure` discards the held body error on exactly the runs
    // that carry BOTH a regression and a leak.
    //
    // `revokeQuietly` records `ok:false` when the revoke threw, and an unread
    // evidence line reads as a clean run — so that entry is a verdict here too,
    // not prose. It is folded in by `fleetCleanupProblems`' third argument now,
    // not by a hand-rolled filter here: `keyLeakProblems`' own fallback calls
    // `revokeQuietly(…, evidence)` for this same `runId`, so the local filter
    // and the shared one both saw those entries and one failing revoke was
    // reported twice.
    settleRun(failure, [
      // The box half, now including the cleanup-time listing (round 4's
      // reversal of the "no honest counterpart" reading — see T1.7), plus the
      // revoke half of the verdict.
      ...fleetCleanupProblems(d8DestroyFailures, d8FinalBoxes, evidence),
      // The key half (F17): revoked-then-reported, on a whole-account basis.
      ...d8KeyProblems,
      // The evidence write, reported as itself rather than laundered through
      // the box verdict.
      ...d8WriteProblems,
    ]);
  },
  // 900 s, not 600 s: the teardown leg alone may consume 420 s, and a runner
  // kill at 600 s aborts the `finally` — losing the evidence write, the box
  // destroy and the key revoke on the slowest (most leak-prone) runs. T1.7's
  // budget for the same leg mix.
  900_000,
);
