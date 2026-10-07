# M1.2 review round 3 triage (driver, 2026-10-06 — final scheduled round)

## FIX
- H1 [HIGH×3 conv] live L2 seeding vs the family-signature seam: L2 now runs on a PROBE repo slug family (`qds-probe-m12-<rand>` — fresh by construction, zero production-memory pollution), seeds BOTH banks (base + base-dev-meta) via createBank, resolves through resolveProvisionedRepoBankId exactly like the seam, cleans both in finally; stale SEAM MIRROR docblock rewritten; brief carries the probe slug.
- M1 [MED conv] items_count:0 refusal refined: skipped when wire async===true (queued-accept modeled by the schema); zero-items failure only for the synchronous shape.
- L-teardown [LOW] refusal line bounded: .slice(0,200) (full twin parity).
- L-score [LOW] byScoreDesc hardened against non-finite scores (treated as 0); the bound removal documented in the schemas conformance comment (#408).
- L-log [LOW] client invalid-extension refusal log sink-guarded (try/catch, same posture as the rest of the diff).
- L-reteardown [LOW] L3 finally gates the teardown-verb backstop on !bodyTeardownOk.
- L-cost [LOW] cost-config.json write wired to the mechanism that actually reads it (investigated; removed if none exists — the cap assertion stays).
- L-emptydocid [LOW] RetainExtensionSchema documentId .min(1) (empty id never rides the wire).
- L-replace [LOW] updateMode without documentId refused pre-fetch (422, "updateMode requires documentId").
- L-emptywire [LOW] recall transform: document_id "" folds to null (the null-tolerance contract gets no third state).

## DISMISS
- D8 M1[blind] re-harvest payload drift overwriting + re-alarming: story AC6 mandates the divergent alarm BY DESIGN; M1.1's harvest is once-per-run (first-close-wins) so content-stable replays are the norm; the drifted-content case is exactly the anomaly the alarm exists to surface. Sibling stories (A5/M3.2/J3) build on this contract.
- D9 L5 status/memoryId placeholders: recorded as issue #408's open decision; the only in-tree consumer (run-retain) ignores both fields.
