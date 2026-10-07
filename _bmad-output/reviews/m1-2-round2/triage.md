# M1.2 review round 2 triage (driver, 2026-10-06)

## FIX
- G1 [HIGH, auditor] AC1 resolution inversion: resolveRepoBankId is a CREATE-side resolver (returns ids NOT in the live list) — recall recalled a nonexistent bank, retain twins wrote to raw-base presence (a foreign bank on collision); the cycle never closed. FIX: new adds-only export in bank-provisioner `resolveProvisionedRepoBankId(baseId, existing)` — candidates safeBase then -2..-11; returns the first c where existing.has(c) AND existing.has(`${c}-dev-meta`) (M1.1's provision shape is exactly [c, c-dev-meta, collective]); null when no provisioned family. kg-context read leg + both retain twins use it (twins: null → retain-skipped "memory banks not provisioned for this repo"). Reverses the round-1 test that enshrined the inversion. The cycle closes: write leg and read leg target the same provisioned bank.
- G2 [HIGH, blind] observationXml sanitizes content but not the documentId attribute — sanitize it through kgContextSanitize before escAttr.
- G3 [MED conv] harness recoverDispatchIds applies the same kg-recall skip as emittedRunId (the failure-path twin still hijacks arming).
- G4 [MED] zero-observation block after the ceiling's whole-observation drop → ladder (c) "empty" (directive + EMPTY_KG_DIRECTIVE, recalledDocumentIds []) ; recalledDocumentIds computed from INCLUDED observations only (row stops advertising undelivered docs).
- G5 [MED] run-retain's own log emissions wrapped (throwing sink no longer converts a landed retain into retain-failed / drops the receipt); receipt-refusal line redacted (String + redactSecrets + slice 200).
- G6 [MED] live L1 fallback made genuinely gated: counting proxy over the real client; second retain ATTEMPT goes through the ledger gate (skips because identity present); assert network retain count stayed 1 + recall unchanged; counts recorded from the proxy, not literals.
- G7 [MED] bundlePath populated at both twins when outcome === "harvested": `<runsDir>/<runId>.bundle` (harvest.ts:19 — verified).
- G8 [LOW] items_count === 0 with success:true → 502 refusal ("retain stored zero items").
- G9 [LOW] teardown.ts post-harvest catch: String() before redactSecrets (twin parity).
- G10 [LOW] live round removes its side-channel row file(s) in finally (round instrumentation must not pollute M1.3's cycle dir).
- G11 [LOW] fan-out observation dedup by fact id (first-seen wins; repo bank ordered first).
- G12 [LOW] box-side drop of non-well-formed kgContext emits one stderr line (guard firing observable).
- G13 [LOW] L2 pushes repoBankId into banksWeCreated BEFORE createBank (L1's discipline — timed-out create still cleaned).
- G14 [LOW] buildRetainPayload bounds repoSlug (≤200, no control chars) and requestId (≤64, SAFE pattern) — the "no prose channel" header becomes fully true.

## DISMISS
- D5 retain-timeout late-completion contradiction: the late ok line + receipt after a timeout is TRUTHFUL evidence (gave up waiting; work landed anyway) — suppressing it would hide a landed retain. Twin returns after the cap; the late line is the honest trace.
- D6 orphan row for non-UUID requestIds the dispatch resolver refuses: R5's documented join limitation extended — production briefs carry UUIDs; the seam cannot know the verb's mint decision. Recorded as an R5 note, not code.

## AMENDMENT
- R7 (extends R5): the row/record join holds only for brief requestIds dispatch accepts (UUID v4); a requestId that passes the row guard but not the resolver leaves an orphan row (uncounted-join cycle). Documented for M1.3.
