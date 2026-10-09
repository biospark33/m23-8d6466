# fx3 — client/schemas cluster (F-025, F-026, offset contract)

Branch: `feature/m3-1-manager-meta-banks-l3-consolidate`. Owned files touched:
`src/hindsight/schemas.ts`, `src/hindsight/client.ts`, `tests/hindsight/client.test.ts`. No edits outside the fence.

## F-025 — ConsolidateResponseSchema tightened — FIXED

- `operation_id: z.string()` now REQUIRED (openapi ConsolidationResponse required list); `counts` stay `.default(0)`; `deduplicated` stays optional. Widening comment rewritten to the WIDENING + TIGHTEN story: legacy-counts-only bodies (pre-M2 mocks) now REFUSE with the why (wire truth; `{}` parsed as success and CONSOLIDATE_UNPARSEABLE was dead code).
- Consequence sweep:
  1. `client.ts` mockBody consolidate updated to the wire shape `{ operation_id: "mock-consolidate-op", deduplicated: false }` — mock mode now parses through the tightened schema.
  2. Mock-mode consumers READ-ONLY, both green without any edit:
     - `tests/memgate/gateway.test.ts` — its only consolidate mention (`gateway.test.ts:543`) is a path-grammar fixture, no client.consolidate call.
     - `tests/hindsight/memory-round-trip.test.ts` — stubs `consolidate` as its own `Promise<unknown>` function (`:54-57`, signature `:30`); never touches ConsolidateResponseSchema. No blocking assertion; no stop.
  3. `tests/hindsight/client.test.ts` dual-parse test rewritten: legacy counts-only arm asserts REFUSAL (HindsightHttpError 502 "failed schema validation") with the F-025 wire-truth comment; wire arm `{operation_id, deduplicated}` still parses; counts+operation_id body parses with counts folded through. The success-path consolidate test body also gained `operation_id` (it carried the legacy shape and refused post-tighten). Mock-mode consolidate test pins `consolidated.operation_id === "mock-consolidate-op"`.

## F-026 — patchMentalModel id validation — FIXED

- Local `assertMentalModelId` in `client.ts` (assertBankId's exact idiom, own labels so the log names the id kind that failed): validates against `BankIdSchema` (same charset, ≤64 chars, no leading/trailing hyphen) BEFORE any fetch, throws HindsightHttpError 422 `invalid mental_model_id: …`, logs `invalid_mental_model_id`. Smallest reuse: no change to assertBankId's exported behavior; BankIdSchema is shared, not duplicated. (Direct `assertBankId(mentalModelId)` reuse was rejected because it would log `invalid_bank_id` for a mental-model id — misleading telemetry.)
- Test: ids `mm/../etc`, `mm-1?detail=full`, `""`, 65×"a" → 422 with no fetch (`lastCall` undefined each iteration).

## Offset contract (for fx2's pagination) — DONE

- `listOperations` opts gains `offset?: number`, appended to the URLSearchParams when provided. Test pins `…/operations?type=refresh_mental_model&limit=50&offset=50`.

## Behavior-change flags (intentional)

1. **Schema tighten = intentional behavior change**: a legacy-counts-only consolidate body now REFUSES (client 502). The real wire always carries operation_id; fx2 notified via this contract line — if any fx2-side fixture feeds counts-only bodies through a real HindsightClient.consolidate, it must add operation_id.
2. **patchMentalModel now refuses malformed mentalModelId pre-fetch** (422) — new refusal path on ids that previously rode the URL raw.
3. Mock-mode consolidate body shape changed (counts → wire shape) — canned-body consumers asserting the old shape would need updating (none found; both focal-adjacent suites green).

## Check outputs

- `bun test tests/hindsight/client.test.ts` → exit 0, **52 pass / 0 fail**
- `bun test tests/memgate/gateway.test.ts tests/hindsight/memory-round-trip.test.ts` (read-only) → exit 0, **82 pass / 0 fail**
- `bunx @biomejs/biome check` on the three owned files → exit 0
- `bunx tsc --noEmit` → exit 2, ONE error: `scripts/p0-9/leg-lib.ts(611,3) TS2322`. **Not from this cluster**: with my three files reverted to HEAD, the same error persists (1 error) — it comes from the concurrent fixers' in-flight edits to `scripts/p0-9/leg-lib.ts`, `src/hindsight/bank-provisioner.ts`, `scripts/provision-hindsight-banks.ts` (all modified on disk mid-run; one writer also clobbered my edits once mid-round — re-applied and re-verified).

fx3 done
