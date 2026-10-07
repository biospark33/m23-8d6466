# Edge Case Hunter — m1.2 round 3 (final gate)

Scope: diff hunks only; new unhandled edges in the final state of the changed code. Handled paths discarded silently.

---

## HIGH

**H1. Live L2 seeds a bank WITHOUT the `-dev-meta` sibling the seam's family signature requires — the flagship leg cannot pass on a fresh (or stale-family) memory instance, and the failure surfaces as an opaque assertion.**
- Files: `tests/fleet/e2e/memory-cycle.live.test.ts:563-572` (seed: `resolveRepoBankId` + `createBank(repoBankId)` only) vs the seam it exercises: `src/hindsight/kg-context.ts:376` and the retain twins (`scripts/fleet.ts:6163`, `src/fleet/run-completion.ts:283`), which call `resolveProvisionedRepoBankId` — resolved ONLY when candidate AND `${candidate}-dev-meta` both exist.
- Trigger A (fresh instance): L2 creates only `<base>`; the dispatch subprocess's seam finds no family → returns null → proceed-unprimed → row `{primed:false, directive:"none"}` → `expect(row.primed).toBe(true)` fails, and L3's outcome-document probe fails the same way (retain twin also skips: "banks are not provisioned").
- Trigger B (stale family): a prior provision left `<base>` + `<base>-dev-meta`; `resolveRepoBankId` returns a fresh `<base>-2`, L2 seeds it, but the seam resolves the OLD `<base>` family → recalls a bank without the marker → `row.banks`/`recalledDocumentIds` assertions fail.
- Guard: seed the FAMILY, not the bank — `await mem.createBank(repoBankId); await mem.createBank(`${repoBankId}-dev-meta`);` (and push both into `banksWeCreated`), or assert/require the family signature before firing dispatch and fail with a message naming the precondition.
- Consequence: AC7's centerpiece leg is environmentally unpassable without a hidden out-of-band provision; operators debug a green system via a red test.

## MEDIUM

**M1. G8 zero-items refusal ignores `async` — an async-queued retain response is misclassified as a failed retain.**
- File: `src/hindsight/client.ts:329-337`.
- Trigger: server answers `2xx {success:true, async:true, items_count:0}` (work queued, not yet stored). The schema deliberately models `async: z.boolean()` (src/hindsight/schemas.ts) but the refusal check reads only `items_count === 0` → `HindsightHttpError(502, "retain stored zero items")` while the document may land later. Run-retain then logs `retain-failed`, no receipt row, and M1.3 counts a cycle that actually landed.
- Guard: `if (... items_count === 0 && (raw as {async?: unknown}).async !== true) throw ...` — or pin the measured shape so `async:true` is refused loudly with its own message instead of the "stored zero items" one.

## LOW

**L1. Empty-string `documentId` passes the retain extension schema and rides the wire.**
- File: `src/hindsight/client.ts:296-305` (`RetainExtensionSchema` is `z.string().optional()`; `if (metadata?.documentId !== undefined) item.document_id = metadata.documentId`).
- Trigger: a caller passes `documentId: ""` → `document_id: ""` sent; server-side upsert identity becomes the empty string — all such items collapse into one anonymous document (or 422, unmeasured).
- Guard: `if (metadata?.documentId !== undefined && metadata.documentId !== "") item.document_id = ...` (or `.min(1)` in `RetainExtensionSchema`).

**L2. `updateMode:"replace"` without a `documentId` is accepted silently — replace semantics are inapplicable and nothing tells the caller.**
- File: `src/hindsight/client.ts:258-268` (docstring) / `301-305` (wire mapping).
- Trigger: `{updateMode:"replace"}` with no `documentId` → extension parses, no `document_id` on the item → every call creates a NEW document; the caller believes replay-replace happened and idempotency silently does not.
- Guard: refuse the combination pre-fetch — `if (metadata?.updateMode !== undefined && metadata?.documentId === undefined) throw new HindsightHttpError(422, "updateMode requires documentId", requestId)`.

**L3. Wire `document_id: ""` becomes `documentId: ""` (not null) and propagates as a real id.**
- Files: `src/hindsight/schemas.ts:198,210` (`document_id: z.string().nullish()`; transform `r.document_id ?? null` — `??` passes `""` through) → `src/hindsight/kg-context.ts:404-408` (`filter((d): d is string => d !== null)`).
- Trigger: a recall result carrying `document_id: ""` → the observation renders `documentId=""` in the block and `""` is advertised in `recalledDocumentIds`, so M1.3 probe-recalls on an empty id; the null-tolerance contract ("absent → null, not \"\"") has a third state it does not handle.
- Guard: `documentId: r.document_id ? r.document_id : null` in the transform (empty string folds into absent).

---

Not reported (verified handled): `MINTED_RUN_ID_RE` has no `/g` flag so the new per-line `exec` loop is stateless (live-harness.ts:308); `residentContextLines`' default `warn` rides `writeAll`, which swallows write failures (pipeline-run.ts:603-615); `recordRequestId` always returns a string; the retain twins' wall-clock race guards both late rejection (`body.catch`) and timer cleanup; array/scalar JSON documents pass through `ingestBriefJson` untouched; `primeDispatchBrief` never throws and ladders (a)–(d) are mutually exhaustive; the kg charset regex ranges correctly exclude exactly \t and \n.
