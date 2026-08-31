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
// The production page bound, imported rather than restated: the D6 case below
// asserts the harness verifies the same population the factory does.
import { MAX_VERIFY_PAGES } from "../../../src/providers/credentials.ts";
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

/**
 * D6 — the leak check must REFUSE to render a verdict it cannot support.
 *
 * `listedKeyHashes()` used to call `listAllKeys(10)` and DISCARD `truncated`,
 * so on an account it could not fully enumerate, both the leak baseline and the
 * delta were computed over a partial population. The direction is what makes it
 * a real-money defect rather than a tidy-up: every leak assertion in this
 * directory is `not.toContain(hash)`, which a PARTIAL list satisfies
 * SPURIOUSLY — the hash may sit in the pages nobody read, so an empty `leaked`
 * array would mean "we did not look" while claiming "nothing leaked". Round 6
 * made that delta assert, which left it looking authoritative while still being
 * unsound at scale.
 *
 * PROVEN AGAINST THE REAL API, NOT A STUB. `listAllKeys` proves exhaustion only
 * by reaching an EMPTY page, so a bound of 1 cannot prove it for any account
 * holding at least one key: the provider really does return a truncated walk,
 * and the guard really does throw on it. A stubbed `truncated: true` would
 * prove only that the assertion fires — never that the API produces the
 * condition, which is the half that matters.
 *
 * Zero boxes, zero keys minted, zero model spend: this is two real GETs
 * against /keys.
 */
test.todoIf(liveTodoOff())("D6: a truncated key listing FAILS LOUDLY instead of under-reporting a leak", async () => {
  liveGate("1");
  const evidence: Record<string, unknown>[] = [];
  let outcome = "FAIL";
  try {
    // The default bound (MAX_VERIFY_PAGES, shared with production) enumerates
    // this account for real — the control, without which the refusal below
    // could be a broken API rather than a working guard.
    const full = await listedKeyHashes();
    evidence.push({ phase: "full-listing", ok: true, bound: MAX_VERIFY_PAGES, count: full.size });

    // Stated precondition, asserted rather than assumed: `listAllKeys(1)`
    // truncates exactly when page 0 is NON-empty (an empty page is the only
    // exhaustion proof), so the bound-1 walk throws on any account holding at
    // least one key. The full listing reached an empty page by construction
    // (it did not throw above), so `full.size > 0` IS the real requirement
    // here — but when it fails, the failure must NAME the environment the
    // guard needs, not leave a bare count mismatch pointing nowhere.
    expect(full.size,
      "D6 needs an account holding at least one key: `listAllKeys(1)` proves exhaustion only by reaching an EMPTY page, so on a fully pruned account the bound-1 walk never truncates and this guard is unprovable — mint or restore a key on the OPENROUTER_PROVISIONING_KEY account and re-run",
    ).toBeGreaterThan(0);

    // The same real call, at a bound that cannot reach the empty page.
    let threw: Error | undefined;
    try {
      await listedKeyHashes(1);
    } catch (e) {
      threw = e as Error;
    }
    evidence.push({
      phase: "truncated-listing",
      bound: 1,
      threw: threw !== undefined,
      message: threw?.message.slice(0, 400) ?? null,
    });

    // It refuses…
    expect(threw).toBeDefined();
    expect(threw?.message).toContain("key-list-truncated");
    // …says why the verdict is withheld rather than just that something failed…
    expect(threw?.message).toContain("MUST NOT report a leak verdict");
    // …and names the two things an operator can actually do about it.
    expect(threw?.message).toContain("MAX_VERIFY_PAGES");
    expect(threw?.message).toContain("prune the account");
    outcome = "PASS";
  } finally {
    // T1.7's posture (:481-486): an evidence-write throw must not replace the
    // test's own failure — and it must not skip the workspace cleanup either.
    try {
      writeEvidence("t1-6-key-list-truncation", { test: "D6", outcome, phases: evidence });
    } catch (e) {
      process.stderr.write(`[D6] evidence write failed: ${(e as Error).message}\n`);
    }
  }
});
