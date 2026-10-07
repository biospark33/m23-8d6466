# Blind Hunter — Round 3 (final gate)

Scope: diff only (`_bmad-output/reviews/m1-2-round3/diff.patch`, 5,084 lines, read in full). Findings are defects in the FINAL state of each hunk only.

---

## HIGH

### H1. Live round L2/L3 is built on the wrong bank resolver — the seeded bank can never be resolved by the seam it claims to mirror; production-family case pollutes production memory

**Defect:** `tests/fleet/e2e/memory-cycle.live.test.ts` L2 resolves and creates the probe bank with the CREATE-side resolver and a single `createBank` — `resolveRepoBankId(resolveBankId(REPO_SLUG), existing)` then `await mem.createBank(repoBankId)` — which by construction returns an id NOT in the live list and creates it WITHOUT the `-dev-meta` sibling. But the production seam this leg is supposed to mirror resolves by FAMILY SIGNATURE: `primeDispatchBrief` (src/hindsight/kg-context.ts) calls `resolveProvisionedRepoBankId`, which returns a candidate only when BOTH the bank and its `-dev-meta` sibling exist, and the harvest retain (fleet.ts / run-completion.ts twins) uses the same family resolver. The docblock's claim — "L2 resolves the bank the SAME way the seam does — `resolveRepoBankId(resolveBankId(repoSlug), liveBanks)`" — is false in the final state; the seam drifted to family-signature resolution and this round did not follow.

**Consequences (both substrate states fail):**
- Fresh substrate (no family anywhere): the seam's `resolveProvisionedRepoBankId` finds base exists but `base-dev-meta` missing, walks -2..-11, finds nothing → returns null → ladder (b) proceed-unprimed → L2's `expect(row.primed).toBe(true)`, `expect(row.directive).toBe("kg_context")`, and `recalledDocumentIds` containing `primeDocId` all fail. L3's retain is skipped the same way → `expect(receipts.length).toBe(1)` fails. The round cannot pass.
- Production family already provisioned at the base id: the seam resolves the PRODUCTION base bank (first family-signature match wins, ahead of the L2-created suffixed candidate). The fan-out recalls production memory — the seeded marker is never recalled — and L3's harvest retain writes the test run's outcome document INTO the production bank. `expect(receiptDetail?.bank).toBe(repoBankId)` fails, and the pollution is not cleaned: `banksWeCreated` holds only the suffixed id, so cleanup deletes that and leaves the test outcome document resident in production memory.

**Evidence:** memory-cycle.live.test.ts L2 seeding block (`resolveRepoBankId` + single `createBank`, no `-dev-meta` creation anywhere in the leg); kg-context.ts `primeDispatchBrief` ("resolveProvisionedRepoBankId(resolveBankId(repoSlug), existing); if (repoBankId === null) return emitAndReturn(false, ...)"); bank-provisioner.ts `resolveProvisionedRepoBankId` (requires `${candidate}-dev-meta`); the SEAM MIRROR docblock asserting equivalence with `resolveRepoBankId`. Note the unit-level seam tests (dispatch-kgcontext-seam.test.ts, kg-context.test.ts) DO stub family lists with `-dev-meta` siblings — only the live round diverges.

---

## MEDIUM

### M1. Retain idempotency assumes byte-identical payloads but the payload embeds live counts/classification — any drift silently overwrites the earlier outcome document and permanently trips the divergent-evidence alarm

**Defect:** `run-retain.ts` keys the upsert on `documentId = runId` with `updateMode:"replace"`, and the receipt's coalesce identity is `(runId, hop, event, documentId)`. But the payload content is `exitClassification` + `harvestedCount` (+ bundlePath/spend), i.e. live harvest state, not a stable identity. The retain seam re-fires on EVERY harvest leg: `fleet harvest`, the teardown verb's harvest step, and re-harvests. Nothing enforces that a second retain for the same run is byte-identical to the first — "idempotent" holds only for coincidentally identical replays. When content drifts (e.g. a later harvest/teardown-harvest of the same run reports a different `harvestedCount`, or `outcome:"none"` → classification flips green→unsettled):
1. the substrate UPSERTS (replace wins on the wire) — the green outcome document is silently overwritten by the lower-information one;
2. the audit store REFUSES the new receipt (divergent-evidence alarm) and keeps the FIRST digest — the permanent ledger now misdescribes the substrate (receipt contentDigest ≠ retained content) and every further re-harvest re-alarms.

The diff's own L3 re-harvest leg only asserts `matchesAfterReplay === 1` and `receipts.length === 1` — it asserts the count, not the content, so a green→unsettled overwrite would pass the round unnoticed. The one test that covers divergence (run-retain.test.ts) frames it purely as an external tamper scenario, not as the system's own re-harvest path.

**Evidence:** run-retain.ts `buildRetainPayload` (live fields) + `retainRunOutcome` order (client.retain replace, then receipt whose divergent arm "keeps the first row and logs the divergence"); fleet.ts `retainRunOutcomeBestEffort` (`exitClassification: input.outcome === "harvested" ? "green" : "unsettled"`, `harvestedCount: input.count ?? 0`); teardown.ts firing `postHarvest` on every non-waived teardown harvest; live test L3 re-harvest assertions (count-only).

---

## LOW

### L1. teardown.ts postHarvest catch is not total — a null/undefined/non-Error rejection throws inside the catch and aborts teardown before revoke+destroy

**Defect:** the catch builds `redactSecrets(err.message ?? e)`. For `postHarvest` rejecting with `null`/`undefined`, `(e ?? {})` yields `{}` and `err.message ?? e` evaluates back to `null`/`undefined`; for a non-Error value (number/object) it evaluates to that value. `redactSecrets` is used everywhere else in this diff as a plain string transform, so it raises on the non-string — and that TypeError is thrown from inside the catch block itself, unwrapped, propagating out of `teardownSteps` and skipping step 4 (revoke) and destruction. That is precisely the box/key leak the isolation exists to prevent, and it contradicts the same hunk's stated contract: "The injected hook is untrusted here regardless of what its own body catches." Currently unreachable via the two in-repo injections (both best-effort twins are catch-all and never reject), hence LOW — but the guard is documented as total and is not.

**Evidence:** src/providers/teardown.ts postHarvest fire-and-catch block (`const err = (e ?? {}) as {...}; ... message: redactSecrets(err.message ?? e)`); contrast with fleet.ts/run-completion.ts, which wrap even `String/redactSecrets` construction in their own try ("F9: the failure line's own construction ... is guarded too").

### L2. G8 zero-items arm contradicts the response schema's own modeled `async:true` accept

**Defect:** `RetainWireSchema` explicitly models `async: z.boolean()` — both values legal — but `client.retain` throws `502 "retain stored zero items"` on any `success:true, items_count:0` body. A server answering the naturally-shaped async accept (`{success:true, items_count:0, async:true}`, i.e. queued, stored shortly) is reported as a hard failure: `retainRunOutcome` issues no receipt for a document that will land, the best-effort twins log `retain-failed`, and the operator's alarm fires for a retain that succeeds server-side moments later. 0.10.0 measured `async:false`, so this is latent — but the schema models the field and the mirror arm rejects its natural true-case, a contradiction inside the final state.

**Evidence:** src/hindsight/client.ts G8 arm; src/hindsight/schemas.ts `RetainWireSchema` (`async: z.boolean()`).

### L3. RecallResponseSchema silently dropped the score bounds (`min(0).max(1)`)

**Defect:** the pre-change schema required `score: z.number().min(0).max(1)`; the conformance transform uses `score: z.number().optional()` with `?? 0`. Zod's `z.number()` accepts `±Infinity` (only `.finite()` excludes it) and any magnitude. Out-of-range/infinite scores now flow unguarded into `byScoreDesc` (`b.score - a.score`), where two Infinities produce a NaN comparator and arbitrary magnitudes fully control rank order — the ordering that decides what the resident gets primed with. The loosening is nowhere called out in the conformance commentary (only `content`/`score` "old-name tolerance" is documented, not the bound removal).

**Evidence:** src/hindsight/schemas.ts RecallResponseSchema (old block removed in the diff; new `score: z.number().optional()`), kg-context.ts `byScoreDesc`.

### L4. client.ts invalid-extension refusal log is not sink-guarded — the one new log that violates the diff's own G5 posture

**Defect:** every other new log emission in this diff is wrapped so "a throwing sink must never ..." (skipLine in both twins, the memory-retain line, the receipt-refusal line in run-retain.ts). The `invalid_retain_extension` refusal log in `client.retain` is bare: if the sink throws, the sink's error replaces the typed `HindsightHttpError(422)` as what surfaces to the caller, and the requestId-scoped structured refusal record is lost. Failure still surfaces (not silent), hence LOW — but it is the single inconsistent member of a posture the diff itself declares load-bearing.

**Evidence:** src/hindsight/client.ts `retain` — `log({...error: {code: "invalid_retain_extension"...}}); throw new HindsightHttpError(422, ...)` with no try/catch, vs. run-retain.ts's G5 wrapping of the equivalent lines.

### L5. RetainResponse transform pins `status` to "created" and `memoryId` to "" — legacy consumers lose the upsert distinction with no call-site evidence in the diff

**Defect:** the transform emits `status: "created" as const` unconditionally and `memoryId: w.id ?? ""` from a forward-compat field "no current server emits". Any pre-existing consumer of `client.retain()` that distinguished `created` from `updated` (upsert replays — exactly what M1.2 now performs routinely) or that keyed anything on `memoryId` now silently misreads every response. The placeholder is documented as issue #408's open decision, but the diff contains no grep-equivalent evidence that no such consumer exists on the shared client surface (run-retain.ts ignores both fields; other callers are out of view). Silent behavior change on a shared boundary.

**Evidence:** src/hindsight/schemas.ts `RetainResponseSchema` transform; client.test.ts mock pins (`expect(res.memoryId).toBe("")`, `status` always "created").

### L6. L3's finally re-runs the teardown verb even after a fully green body teardown

**Defect:** `bodyTeardownOk` gates only the destroy backstop (`if (ctx !== undefined && vmName !== "" && !bodyTeardownOk)`), not the teardown-verb backstop — `teardownQuietly([... "--no-harvest"], ...)` runs unconditionally whenever `ctx`/`recordsDir`/`runId` are armed, including immediately after the body's own teardown verb exited 0 and proved the box gone. If teardown of an already-closed run is not exit-0 (the diff asserts idempotency for revoke — "'revoked' | 'already-gone' both OK" — but shows nothing for second-teardown of a closed record), `torn.ok` is false, `destroyFailures` gets an entry, and `fleetCleanupProblems` fails a fully green round in cleanup.

**Evidence:** memory-cycle.live.test.ts L3 — `bodyTeardownOk = true` set after the box-gone proof; the finally's `teardownQuietly` call guarded only on `ctx/recordsDir/runId`, with `bodyTeardownOk` consulted solely by the destroy backstop.

### L7. L2 writes cost-config.json but nothing in the leg points the dispatch child at it — the round's stated cap figure is decorative

**Defect:** L2 writes `{defaultCapMicroUsd, boxHourRateMicroUsd}` to `join(round.workspace, "cost-config.json")`, then runs the dispatch verb with `--brief`, `--dir`, cwd REPO_ROOT, and env `{QDS_RUNS_DIR, QDS_AUDIT_DB}` — no flag, env var, or path in the leg references the file. Unless `scripts/fleet.ts` discovers cost config from a path the diff never shows (it is not the cwd, not the runs dir parent it is named for is passed, and `QDS_RUNS_DIR` names the runs dir, not the workspace root), the child prices the box/key from defaults and the round's advertised "capped at 50,000 µ$" is whatever the child's default is. The only thing actually enforcing the cap in-round is L3's `expect(rec.limitMicroUsd).toBe(T2_CAP_MICRO_USD)` — which would fail the round after real spend rather than bound it beforehand.

**Evidence:** memory-cycle.live.test.ts L2 — `writeFileSync(join(round.workspace, "cost-config.json"), ...)` followed by `runFleet(["dispatch", "--driver", "exedev", "--brief", briefPath, "--dir", round.recordsDir], { cwd: REPO_ROOT, env, ... })` with `env = { QDS_RUNS_DIR, QDS_AUDIT_DB }`.
