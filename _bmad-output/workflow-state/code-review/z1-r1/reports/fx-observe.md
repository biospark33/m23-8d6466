# fx-observe — fix report, round z1-r1

Branch: feature/z1-adapter-contract-v2. Scope: tests/fleet/observe-contract.ts, tests/fleet/q1-contract.test.ts only.

## F-014 (MED) — AC3 purity negative control — PATCHED
`tests/fleet/observe-contract.ts` result branch: after the exit-4 probe, a poisoned-deps probe re-polls the SAME record (`qds-20260928-obsv01`) with the driver replaced by a Proxy whose every property access throws (`then` guarded so no stray await mistakes it for a thenable) and a `ledgerFactory` that throws itself. Asserts exit 0, one line, payload `toEqual` the earlier healthy poll's payload — proving `runResult`/`buildResult` touch neither driver nor ledger (verified against source first: `scripts/fleet.ts` `runResult` reads only `deps.store`; `src/fleet/result.ts` `buildResult(store, runId)` is a pure record read). Asserted inside the existing result sweep, one helper-internal probe.

## F-015 (LOW) — second recorded schema debt — PATCHED
`observe-contract.ts` docblock gains a STATE-VOCABULARY DEBT paragraph: STATUS_VOCABULARY pins the closed docblock enumeration, but the wire types `state` as `(string & {})` in src/fleet/status.ts — a deliberate fail-visible passthrough (unknown approval states render as-is). Consumers must tolerate unknown state words; this suite pins the enumeration, and the passthrough debt rides a deliberate grammar bump exactly like the schema-version debt (DD-28.5 pattern). src/ untouched (outside the box COPY set).

## F-016 (LOW) — expectExactFields dedup + refusal meta-test — PATCHED
- `observe-contract.ts`: `expectExactFields` now exported, docblock marks it THE canonical copy.
- `q1-contract.test.ts`: the local duplicate function is deleted (that was the finding — it existed twice); a one-line pointer comment replaces it and the import comes from observe-contract. Existing submit/result callsites unchanged.
- ONE meta-test added to the observe describe: a fat payload (extra `schemaVersion` key) and a short payload (missing `state`) each throw with the offending field named in the message — the DOD's "missing AND extra-field refusals demonstrated".

## F-017 (LOW) — closure test name overclaim — PATCHED
Reworded to: "the observe contract's allowed verb set is exactly status and result — both rows present in the registry, result driver-free, status's --driver owned by the deployed wrapper, and every other verb outside this contract (INV-Z1-2)". Test body untouched.

## Constraints honored
The 4 pre-existing observe tests and all other describes are byte-identical except F-017's single test-name reword. No other files touched.

## Verification
`bun test tests/fleet/q1-contract.test.ts` → **15 pass / 0 fail** (was 14 pass; +1 meta-test), 716ms.
