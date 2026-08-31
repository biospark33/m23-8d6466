# T1 — tests/fleet/e2e/tier1-approval-gate.live.test.ts (Wave 2)

Not run (live: real exe.dev box + real billable OpenRouter key). Verified by
inspection + `bunx tsc --noEmit` + `bunx biome check` + a gated-off load check.

## Verdict table

| # | Finding | Verdict | Note |
|---|---------|---------|------|
| 1 | **[BLOCKER]** `pauseSucceeded` means "requestApproval returned", not "teardown ran" — box + key leak on every non-`fresh` outcome | **fixed** | Confirmed against `src/fleet/approval-gate.ts`: teardown runs only on the `promote === true` tail (fresh registration at :503, resume at :441). `pause-in-progress` (:438), `already-decided` (:446) and `rebound` (:482) all return at :506-509 **before** `deps.teardown` at :544. Fix went further than gating on `order.includes("teardown-done")`: the flag is **deleted** and neither cleanup is gated on teardown evidence at all. The destroy is already guarded by `driver.list(runId).some(...)`, which is a strictly better gate (it asks the substrate, not a local flag); the revoke is guarded by `keyWasMinted` and `revokeQuietly`'s own `rec.keyHash` check, and a redundant revoke of an already-revoked hash answers 404 → `already-gone` (`credentials.ts:478`), i.e. free. `order` is hoisted to the test scope and its true signal is now recorded as `{phase:"finally-teardown-ran", tornDown, order}` — kept as forensics, load-bearing for nothing. Fail-safe in both directions. |
| 2 | **[HIGH]** key-leak delta computed, serialized, never asserted | **fixed** | `leaked` hoisted to the test scope, still written to evidence, and asserted `expect(leaked).toEqual([])` **after** the `try/finally`, not inside it. Inside, biome's `lint/correctness/noUnsafeFinally` rejects it (verbatim output below) and it would overwrite the body's real failure. Outside, the statement is reached only when the body passed — which is exactly the case the assertion is for; a failing run already fails and the evidence carries the leak either way. |
| 2b | `listedKeyHashes()`'s `listAllKeys(10)` bound | **confirmed unsound — fix belongs in `live-harness.ts` (not mine)** | The `10` is **pages**, not entries (`KeyApi.listAllKeys(maxPages)`, `src/providers/credentials.ts:122`). The interface documents the contract — "either follows pages to exhaustion or reports `truncated: true` — absence is never inferred from a partial page" (:104-106) — and `listedKeyHashes` **discards `truncated`**. On a truncated list both the baseline and the delta are computed over a partial population, so a leak can hide and the check is unsound even now that it is asserted. Exact edit below. |
| 3 | **[HIGH]** AC7 has no positive control | **fixed** | Added immediately after create: `expect(vm).toBe(runId)` and `expect((await ctx.driver.list(runId)).some(b => b.name === runId)).toBeTrue()`. Caveat worth recording: `ExeDevDriver.create` returns `{ name, httpsUrl }` built from its own `name` parameter (`driver.ts:186`, `:194`), so `vm === runId` is true by construction and is documentation, not a check. The load-bearing control is the `list()` presence assert — that one can genuinely fail, which is the point given `listWithAnomalies` excludes rows outside the factory name grammar and diverts unreadable rows to the anomaly channel (`driver.ts:211-241`). |
| 4 | **[MED]** `revokeQuietly` can throw out of the `finally` | **fixed at the call site; helper fix stated below** | Confirmed: `const rec = store.get(runId)` at `live-harness.ts:355` sits outside the helper's own `try` (:359). Call site now wrapped, pushing `{phase:"finally-revoke", ok:false, error}` — the ledger close, the evidence write and the workspace `rmSync` survive a record-read throw, and the test's real error is not replaced. |
| 5 | **[LOW]** only `approve`'s output scanned for the token | **fixed** | `expect(second.stdout + second.stderr).not.toContain(APPROVER_TOKEN)` added on the `reject`/already-decided invocation, and that phase's evidence now captures `stderr` too (it previously captured only `stdout`). Confirmed the harness scrubber cannot help: `scrubText` (`live-harness.ts:130-138`) strips `sk-or-…`, `sk-…{20,}` and `OPENROUTER_PROVISIONING_KEY`'s value — an approver token matches none. |
| 6 | **[LOW]** `expect(hashesBefore.has(hash)).toBeFalse()` near-tautology | **fixed (deleted)** | Replaced by a comment naming why it could not fail. The surviving `expect(await listedKeyHashes().then(s => s.has(hash))).toBeTrue()` is the check that can fail and is what makes the post-teardown absence assert meaningful. |

### Wave-1 behaviour changes — verified against current source, no test expectation moved

- `requestApproval` throws when the record is open, owns a `vmName`, and `deps.teardown` is absent (`approval-gate.ts:534-538`). **Unaffected** — this test passes a real teardown.
- Resume of a `pausing` record whose bound `reportId` matches now re-runs teardown and returns `{outcome:"requested"}` (`:426-441`). **Both existing assertions stay correct on that path**: `expect(pause).toEqual({outcome:"requested"})` and `expect(order).toEqual(["teardown-start:pausing","teardown-done"])` — the resume arm writes nothing before teardown, so the observed state is still `pausing` and teardown is still called exactly once.
- `submitDecision` throws on blank `approverId`, non-`approved|rejected` decisions, and `approverId === "system:timeout"` (`:588-604`). **Unaffected** — the test submits a real allowlisted id.
- `attachToRun`'s `attach-not-acked` `reason`, and `fleet attach` emitting `dispatchRequestId`: **not asserted here** — this test asserts the AC5 refusal envelope (`run-not-attachable`, `state: "awaiting-approval"`) and never reads attach stdout.

## The env gate, verbatim

The test declaration (`tier1-approval-gate.live.test.ts:123`):

```ts
test.todoIf(liveTodoOff())(
```

`liveTodoOff` (`live-harness.ts:72-74`):

```ts
export function liveTodoOff(): boolean {
  return process.env.QDS_E2E_LIVE !== "1";
}
```

First statement of the body (`:126`) is `liveGate("1")`, which THROWS (never skips) on a half-configured env (`live-harness.ts:55-69`):

```ts
export function liveGate(tier: "1" | "2"): void {
  if (process.env.QDS_E2E_LIVE !== "1") {
    throw new Error("QDS_E2E_LIVE is not 1 — this todoIf-gated test must not run");
  }
  if (process.env.QDS_E2E_TIER !== tier) {
    throw new Error(`QDS_E2E_TIER is ${JSON.stringify(process.env.QDS_E2E_TIER)}, not "${tier}" — refusing to run at the wrong tier`);
  }
  const missing = SUBSTRATE_ENV.filter((name) => (process.env[name] ?? "").trim() === "");
  ...
```

So the body cannot run without `QDS_E2E_LIVE=1` **and** `QDS_E2E_TIER=1` **and** all of `QDS_EXEDEV_REPO_URL`, `QDS_EXEDEV_SHA`, `QDS_EXEDEV_ROSTER`, `OPENROUTER_PROVISIONING_KEY`. Verified `QDS_E2E_LIVE` is unset in the environment, absent from the repo `.env` (bun auto-loads it), and there is no `.env.local` — the load check below therefore could not have reached the body.

## Exact edits needed in `live-harness.ts` (NOT mine — 10 other live tests import these)

**(a) `listedKeyHashes` must fail closed on a truncated list** (`live-harness.ts:304-308`), matching `revokeHash`'s existing `list-unverified` posture at `credentials.ts:462-468`:

```ts
export async function listedKeyHashes(): Promise<Set<string>> {
  const keyApi: KeyApi = openRouterKeyApi();
  const { entries, truncated } = await keyApi.listAllKeys(10);
  if (truncated) {
    throw new Error(
      "listedKeyHashes: the provider key list did not enumerate within 10 pages — a leak check over a truncated population proves nothing",
    );
  }
  return new Set(entries.map((e) => e.hash));
}
```

**(b) `revokeQuietly`'s record read must be inside its own `try`** (`live-harness.ts:355-358`) — move it in, so the helper keeps its documented "never throws" contract for every caller, not just this one:

```ts
  try {
    const rec = store.get(runId);
    if (!rec.keyHash) return; // no key was ever minted — nothing to revoke
    const keyApi: KeyApi = openRouterKeyApi();
    const result = await revokeRunKey({ keyApi, driver, store }, runId);
    evidence.push({ phase: "finally-revoke", runId, result, ok: result !== "none" });
  } catch (e) {
```

Consumers of both helpers (do not break them): `tier1-teardown`, `tier2-dispatch-engine`, `tier2-fanout-bestofn`, `tier3-{expose-port,manystories,race,reaper,remote-phases}`, `tier4-resident`.

## Verification output, verbatim

`bunx tsc --noEmit` (whole project):

```
TSC_EXIT=0
```

(no diagnostics printed)

`bunx biome check --write tests/fleet/e2e/tier1-approval-gate.live.test.ts` — first run, with the leak assertion still inside the `finally`:

```
tests/fleet/e2e/tier1-approval-gate.live.test.ts:421:9 lint/correctness/noUnsafeFinally ━━━━━━━━━━━━

  × Unsafe usage of 'throw'.

    419 │       // masking the real error with this one would cost the diagnosis.
    420 │       if (outcome === "pass" && leaked.length > 0) {
  > 421 │         throw new Error(
        │         ^^^^^^^^^^^^^^^^
  > 422 │           `key leak: ${leaked.length} provider key hash(es) appeared during this run and outlived it: ${leaked.join(", ")} — revoke them by hand (evidence: ${evidencePath})`,
  > 423 │         );
        │         ^^
    424 │       }
    425 │     }

  i 'throw' in 'finally' overwrites the control flow statements inside 'try' and 'catch'.

Checked 1 file in 279ms. No fixes applied.
Found 1 error.
```

After moving the assertion below the `try/finally`:

```
Checked 1 file in 109ms. No fixes applied.
```

Gated-off load check (proves the file still parses/loads and that the gate holds; the body cannot run with `QDS_E2E_LIVE` unset):

```
$ bun test tests/fleet/e2e/tier1-approval-gate.live.test.ts
bun test v1.4.0 (34cbb9a40)

 0 pass
 1 todo
 0 fail
Ran 1 test across 1 file. [130.00ms]
```

Not committed, not pushed. No file other than `tests/fleet/e2e/tier1-approval-gate.live.test.ts` was modified.
