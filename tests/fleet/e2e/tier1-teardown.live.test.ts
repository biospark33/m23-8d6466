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
// Imported, not restated, for the evidence record only — the PARITY this file
// claims does not come from this import. It comes from `listedKeyHashes`
// (live-harness.ts), whose default bound IS this same module constant, and
// from production's own verify path (credentials.ts `verifyHash`/`revokeHash`
// pass the same MAX_VERIFY_PAGES). One shared constant: the harness cannot
// silently drift below the factory's page budget, because there is no second
// number to drift.
import { MAX_VERIFY_PAGES, openRouterKeyApi, revokeAndVerify } from "../../../src/providers/credentials.ts";
import {
  destroyQuietly,
  fleetCleanupProblems,
  fleetLeftovers,
  keyLeakProblems,
  ledgerRows,
  liveGate,
  liveTodoOff,
  mintCappedKey,
  preflight,
  revokeQuietly,
  runFleet,
  runIdFor,
  setEffectiveImage,
  settleRun,
  tmpWorkspace,
  writeEvidence,
  writeEvidenceQuietly,
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
    let outcome = "pass";
    let keyWasMinted = false;
    /** The body's own error, held so the post-finally revoke verdict below runs on the failing path too. */
    let failure: unknown;
    // Hoisted so the finally's belt-and-braces revoke can reach it on every path.
    let store: InstanceType<typeof RunRecordStore> | undefined;
    /** Destroys that FAILED (#189) — rendered AFTER the finally, never swallowed. */
    const destroyFailures: string[] = [];
    /** The cleanup-time leak listing; `undefined` means it FAILED, which is a problem, not a pass. */
    let finalBoxes: string[] | undefined;
    /** The F17 key verdict, rendered in the finally and settled below it. */
    let keyProblems: string[] = [];
    /**
     * Evidence-WRITE failures, kept OUT of `destroyFailures`: a secret-scrub
     * refusal is not a box that failed to die, and `fleetCleanupProblems`
     * renders that array as "cleanup failures: …".
     */
    const writeProblems: string[] = [];
    // The account baseline BEFORE anything is minted — the finally's account
    // delta (EB4) compares against it when the record-backed revoke is blind.
    const hashesBefore = await listedKeyHashes();
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
      // Flag set BEFORE the await: the mint's tail (record stamp, cap
      // validation) can throw after the provider has already created a LIVE
      // billable key, and a flag left false there means the finally's
      // belt-and-braces revoke never fires. Safe to set optimistically —
      // `revokeQuietly` returns "none" with no API call when the record
      // carries no keyHash.
      keyWasMinted = true;
      const { hash } = await mintCappedKey(ctx.driver, store, runId, 5000);
      evidence.push({ phase: "mint", ok: true, keyHash: hash });
      expect(await listedKeyHashes().then((s) => s.has(hash))).toBeTrue();

      // ── the teardown verb, real subprocess, FULL chain (harvest included) ─
      const td = await runFleet(["teardown", runId, "--driver", "exedev", "--dir", recordsDir], { timeoutMs: 420_000 });
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
      // HELD, not thrown: the finally's revoke entries are consumed as
      // assertions below the finally, so on a red run — the run whose key is
      // most likely to still be live — the revoke verdict still renders, and
      // the body's own error is re-thrown LAST so neither masks the other.
      failure = e;
      evidence.push({ phase: "test-error", error: (e as Error).message });
    } finally {
      // If anything above failed mid-chain the key may still be live: belt-and-braces
      // cleanup. Box destroy runs regardless; so does the revoke — a teardown
      // that exits 0 WITHOUT revoking is exactly the leak this fallback exists
      // to catch, and gating on `teardownSucceeded` would trust the chain
      // under test to have cleaned up after itself. `revokeQuietly` of an
      // already-revoked key is a harmless "already-gone" (and returns "none"
      // with no API call when the record carries no keyHash).
      try {
        const still = await ctx.driver.list(runId);
        if (still.some((b) => b.name === runId)) {
          // Through `destroyQuietly` (#189), not a bare `driver.destroy` inside
          // a swallowing `catch`: that shape ate BOTH failures it could see —
          // a list that threw AND a destroy that threw — so a box still billing
          // left no verdict anywhere and the run reported green. The verdict is
          // accumulated and rendered after the finally.
          const destroyed = await destroyQuietly(ctx.driver, runId, evidence);
          if (!destroyed.ok) destroyFailures.push(`${runId}: ${destroyed.error}`);
        }
      } catch (e) {
        // The LIST probe failed — the destroy was never attempted, which is as
        // assertable a leak as a failed destroy: it must not mask the test's
        // own result, and it must not vanish either.
        evidence.push({ phase: "finally-direct-destroy", ok: false, error: (e as Error).message });
        destroyFailures.push(`${runId}: list-before-destroy failed: ${(e as Error).message}`);
      }
      if (keyWasMinted && store !== undefined) {
        // `revokeQuietly` never throws (#189) — an unreadable record lands as
        // a `finally-revoke ok:false` entry, which EB3 below fails the test on.
        await revokeQuietly(ctx.driver, store, runId, evidence);
      }
      // EB4 — the record-backed revoke above is BLIND to the one case the
      // `keyWasMinted` flag exists for: a mint whose tail threw (record stamp /
      // cap validation) after the provider had already created a LIVE key. The
      // record then carries no `keyHash`, `revokeQuietly` answers "none" with
      // no API call, and the key stays billable behind a green-looking cleanup.
      // The account delta still sees it: any hash that appeared since
      // `hashesBefore` and is named by NO record is ours by construction (the
      // sweep runs only when this run's record names no key, and `revokeHash`
      // re-asserts the `sbx-` prefix before every DELETE). Presumes no
      // concurrent live round, which the skill mandates anyway.
      let stranded: string[] = [];
      try {
        const after = await listedKeyHashes();
        stranded = [...after].filter((h) => !hashesBefore.has(h));
        // `ok` EXPLICITLY (F10), and it was the hole in this block: the success
        // arm used to push `{phase, stranded}` with NO `ok` key, while the only
        // reader below filters `p.ok === false`. So a NON-EMPTY `stranded` — a
        // real live key this run had just failed to revoke — read as clean in
        // the exact filter written to find leaks, and only an enumeration
        // ERROR could ever fail the test. `keyLeakProblems` below renders the
        // verdict now; this entry stays as the sweep's own input trail.
        evidence.push({ phase: "key-hash-delta-sweep", ok: stranded.length === 0, stranded });
      } catch (e) {
        // A delta that cannot be enumerated is recorded as such — the
        // post-finally assertions treat an unmeasured key population as a
        // failure, never as "nothing leaked".
        evidence.push({ phase: "key-hash-delta-sweep", ok: false, error: (e as Error).message });
      }
      if (keyWasMinted && store !== undefined && stranded.length > 0) {
        let recordKeyHash: string | undefined;
        try {
          recordKeyHash = store.get(runId).keyHash;
        } catch {
          // An unreadable record is the worst case, not the best: sweep.
          recordKeyHash = undefined;
        }
        if (recordKeyHash === undefined) {
          for (const h of stranded) {
            try {
              // INV-AUDIT-4: `revokeAndVerify` is the ONE sanctioned silent link
              // sink (W14B-3). It runs under a run-less step context and
              // `audit_links.run_id` is NOT NULL, so it emits nothing — wiring
              // `recordLiveAuditLink` here typechecked and did nothing, reading
              // as coverage of a stranded-key revoke link that does not exist.
              await revokeAndVerify({ keyApi: openRouterKeyApi(), driver: ctx.driver, store, recordAuditLink: () => {} }, h);
              evidence.push({ phase: "finally-delta-revoke", ok: true, keyHash: h });
            } catch (e) {
              evidence.push({ phase: "finally-delta-revoke", ok: false, keyHash: h, error: (e as Error).message });
            }
          }
        }
      }
      // The F17 verdict, LAST — after both revoke legs above have had their
      // chance, so it reports what genuinely survived them rather than racing
      // them. It re-lists, revokes any survivor through the record-backed
      // fallback, re-lists again, and returns problem lines; a listing that
      // cannot be enumerated is a problem, never "nothing leaked".
      //
      // It does not REPLACE the EB4 sweep above: `keyLeakProblems`' fallback is
      // `revokeQuietly`, which is record-backed and therefore blind to exactly
      // the case EB4 exists for — a mint whose tail threw after the provider
      // created a LIVE key, leaving no `keyHash` anywhere. EB4 revokes that one
      // by hash; this renders the verdict on whatever is left.
      keyProblems = await keyLeakProblems(
        hashesBefore,
        { driver: ctx.driver, store, runIds: [runId] },
        evidence,
      );
      // The absolute `e2e-|qds-` backstop at CLEANUP time. Every listing this
      // file otherwise takes is scoped to `runId`, so a box standing under any
      // other name — a leftover the teardown verb itself stranded — was
      // invisible to all of them.
      //
      // `fleetLeftovers` (P127/P128/R4): the poll answers the MEASURED 25 s+
      // destroy lag that made this single-shot listing report a leak on a clean
      // paid round; owned survivors are destroyed and re-listed before the
      // verdict; and a box some other round stranded is a labelled warning, not
      // a red on this one. Never throws, so the bare `await` is safe here.
      finalBoxes = (await fleetLeftovers(ctx.driver, [runId], evidence)).owned;
      // `writeEvidenceQuietly` (F11): the secret-scrub REFUSAL throws out of
      // `writeEvidence`, and that throw made `settleRun` below unreachable —
      // the one condition that most needs the verdict machinery was the one
      // condition that skipped it.
      writeEvidenceQuietly("T1.4", "t1-4-teardown-verb", { test: "T1.4", outcome, runId, phases: evidence }, writeProblems);
      if (workspace !== "") rmSync(workspace, { recursive: true, force: true });
    }

    // EB3 — the finally's revoke entries are a VERDICT, not prose. `revokeQuietly`
    // and the delta sweep record `ok:false` on failure; before this wave nothing
    // read those entries, so a failed belt-and-braces revoke rode out the test
    // as unread evidence while the assertion table read a clean run. Consumed
    // AFTER the finally (biome/noUnsafeFinally).
    //
    // Through `settleRun`, not a row of `expect`s: the shape this replaces threw
    // its own AssertionError ahead of `if (failure) throw failure`, so on a run
    // that hit BOTH a teardown-chain regression and a failed cleanup, the held
    // regression was discarded and the operator read the cleanup line instead —
    // then paid for another live round to rediscover the real one. `settleRun`
    // attaches the cleanup problems to the held error and re-throws the
    // ORIGINAL; a cleanup problem on an otherwise-green run is still a failure.
    const unread = (phase: string): Record<string, unknown>[] =>
      evidence.filter((p) => p.phase === phase && p.ok === false);
    settleRun(failure, [
      ...["key-hash-delta-sweep", "finally-revoke", "finally-delta-revoke"].flatMap((phase) => {
        const bad = unread(phase);
        return bad.length > 0 ? [`${phase} failures: ${JSON.stringify(bad)}`] : [];
      }),
      // The box half, now including the absolute cleanup-time listing.
      ...fleetCleanupProblems(destroyFailures, finalBoxes),
      // The key half (F17) — a surviving hash, already revoked by the fallback
      // and named here, because NEEDING the fallback is itself the defect.
      ...keyProblems,
      // The evidence write, reported as itself rather than laundered through
      // the box verdict.
      ...writeProblems,
    ]);
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
      // D6 never calls `preflight` and never creates a box, so nothing stamped
      // the boot-image provenance `writeEvidence` now REFUSES to write without
      // (P125). `null` is the true claim here: "no image" — where inheriting
      // the previous file's stamp would assert this evidence proves bytes D6
      // never booted, which is the order-dependent lie F16 exists to prevent.
      setEffectiveImage(null, { note: "D6 lists key hashes only — no box is ever created" });
      writeEvidence("t1-6-key-list-truncation", { test: "D6", outcome, phases: evidence });
    } catch (e) {
      process.stderr.write(`[D6] evidence write failed: ${(e as Error).message}\n`);
    }
  }
});
