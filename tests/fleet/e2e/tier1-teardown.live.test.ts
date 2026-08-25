/**
 * T1.4 — the `teardown` verb, full chain, on real exe.dev + real OpenRouter
 * key API + REAL SQLite writes (e2e-plan.md paths 5, 10, 4).
 *
 * Proves: real mint (POST /keys, cap 5000 µ$, NEVER used for a model call —
 * minting costs $0); the `fleet teardown` verb as a real subprocess running
 * spend-capture (GET) → artifacts → harvest (degrades to "none": no repo in
 * this box by design — T1.3b already proved harvest with a repo) → revoke
 * (DELETE) → verify → destroy (real box gone) → close + priced box-hours row
 * in the REAL cost-ledger.db (the first real ledger WRITE ever exercised by a
 * fleet test); the key hash is absent from the provider's key list afterwards;
 * the record is closed; a second teardown is refused or idempotent per the
 * verb contract, never a crash.
 *
 * ZERO model spend by construction: the key exists only between mint and
 * revoke and no chat call ever references it.
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RunRecordStore } from "../../../src/providers/run-record.ts";
import {
  ledgerRows,
  liveGate,
  liveTodoOff,
  mintCappedKey,
  preflight,
  revokeQuietly,
  runFleet,
  runIdFor,
  tmpWorkspace,
  writeEvidence,
  listedKeyHashes,
} from "./live-harness.ts";

test.todoIf(liveTodoOff())(
  "T1.4 teardown verb e2e: real mint → spend/artifacts/harvest/revoke/verify/destroy/close → priced ledger row",
  async () => {
    liveGate("1");
    const evidence: Record<string, unknown>[] = [];
    const ctx = await preflight();
    const runId = runIdFor("t14");
    let workspace = "";
    let evidencePath = "";
    let outcome = "pass";
    let keyWasMinted = false;
    let teardownSucceeded = false;
    // Hoisted so the finally's belt-and-braces revoke can reach it on every path.
    let store: InstanceType<typeof RunRecordStore> | undefined;
    try {
      workspace = tmpWorkspace("t14");
      const recordsDir = join(workspace, "runs");
      mkdirSync(recordsDir, { recursive: true });
      // The operator's cost config sits BESIDE the records dir (costLedgerOpts).
      // Without boxHourRateMicroUsd the close step fail-louds with
      // `box-hour-rate-unconfigured` ("must surface, not silently cost 0") —
      // observed live 2026-08-24. $0.23/hr mirrors the exe.dev 2CPU/8GiB rate.
      writeFileSync(join(workspace, "cost-config.json"), JSON.stringify({ boxHourRateMicroUsd: 230_000 }));

      // ── record → box (INV-1), budget attribution so teardown prices hours ─
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

      // ── REAL mint at a tiny cap; plaintext never leaves mintRunKey's return ─
      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
      keyWasMinted = true;
      evidence.push({ phase: "mint", ok: true, keyHash: hash });
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeTrue();

      // ── the teardown verb, real subprocess, FULL chain (harvest included) ─
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 420_000 });
      teardownSucceeded = td.exitCode === 0;
      evidence.push({
        phase: "teardown-verb",
        exitCode: td.exitCode,
        stdout: td.stdout.trim().slice(0, 400),
        stderrFull: td.stderr.trim().slice(-8000),
      });
      expect(td.exitCode).toBe(0);

      // ── revoke verified against the provider's own list ───────────────────
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeFalse();

      // ── box really gone ────────────────────────────────────────────────────
      const boxes = await ctx.driver.list(runId);
      expect(boxes.some((b) => b.name === runId)).toBeFalse();
      evidence.push({ phase: "box-gone", ok: true });

      // ── record closed; spend captured as 0 (key never used) ───────────────
      const rec = store.get(runId);
      expect(rec.closedAt).toBeDefined();
      expect(rec.spendMicroUsd ?? 0).toBe(0);
      evidence.push({ phase: "record-closed", closedAt: rec.closedAt, spendMicroUsd: rec.spendMicroUsd });

      // ── REAL ledger write: the priced box-hours row, keyed to this run ────
      const rows = ledgerRows<{ run_id: string; kind: string; cost_micro_usd: number; unpriced: number; repo_slug: string }>(
        recordsDir,
        "SELECT run_id, kind, cost_micro_usd, unpriced, repo_slug FROM cost_events WHERE run_id = ?",
        runId,
      );
      evidence.push({ phase: "ledger-rows", rows });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows.every((r) => r.kind === "box_hours")).toBeTrue();
      expect(rows.every((r) => r.unpriced === 0)).toBeTrue();
      expect(rows.every((r) => r.cost_micro_usd >= 0)).toBeTrue();

      // ── second teardown: refused or idempotent, never a crash ─────────────
      const td2 = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 180_000 });
      evidence.push({ phase: "teardown-verb-second", exitCode: td2.exitCode, stdout: td2.stdout.trim().slice(0, 200) });
      expect([0, 1, 2, 4, 5, 6]).toContain(td2.exitCode ?? -1);
    } catch (e) {
      outcome = "fail";
      evidence.push({ phase: "test-error", error: (e as Error).message });
      throw e;
    } finally {
      // If anything above failed mid-chain the key may still be live: belt-and-braces
      // cleanup. Box destroy runs regardless; revoke runs ONLY when teardown failed
      // AND a key was minted (the finally-revoke helper checks keyHash presence).
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          await ctx.driver.destroy(runId);
          evidence.push({ phase: "finally-direct-destroy", ok: true });
        }
      } catch {
        // list failure must not mask the test's own result
      }
      if (!teardownSucceeded && keyWasMinted) {
        if (store !== undefined) await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      try {
        evidencePath = writeEvidence("t1-4-teardown-verb", { test: "T1.4", outcome, runId, phases: evidence });
        process.stderr.write(`[T1.4] evidence: ${evidencePath}\n`);
      } finally {
        if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
      }
    }
  },
  600_000,
);
