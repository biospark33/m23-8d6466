# p0-9 closure evidence — reading notes

The JSON files in this folder are kept exactly as the leg drivers wrote them on qds-alpha (2026-10-04). They are not edited after capture. Where a driver's own classification is wrong, the correction is recorded here and fixed in the driver, never in the evidence.

## auth-retired-check (`…-auth-retired-check-tb6g2k.json`)

The `knownKeyOutOfScope` and `unknownKey` probes both got **HTTP 410**. Their response tails show that the bank-profile endpoint was removed in Hindsight 0.10.0, so the request never reached a credential check. The driver labels them `known-key-out-of-scope-http_410` and `unknown-key-refused-http_410`, and those labels are wrong. Read both probes as **inconclusive for authorization**. They prove nothing about credential refusal.

What the file does establish:

- `unauthenticated` answered 200 on retain and recall. The instance accepts unauthenticated writes, so `dangerRetired=false` stands.
- `keyProof` answered 200.

The driver fix (probe a supported endpoint and treat a 410 as inconclusive) belongs to work item 2, the schemas.ts conformance amendment tracked in issue #408. The same 410 misreading affects the negative control in `…-negative-probes-pisa2e.json`.

## document-id-retain-twice (`…-document-id-retain-twice.json`)

The record sets `upsertObserved: true`, which overstates what was measured. Both retains sent the same `document_id` with **identical content**. The second retain used 0 tokens, and the document and node counts stayed at 1. That shows an identical re-retain is a no-op that creates no duplicate. It does not show that a retain with **changed** content updates the existing document. Read this record as a **no-duplicate check**. Proving the update path needs a second retain with different content and a read-back. That probe belongs to work item 2.
