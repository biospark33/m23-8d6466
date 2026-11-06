# A1 bmad-code-review Round 1 — triage (2026-10-15)

Layers: blind-hunter (16), edge-case-hunter (12), verification-gap (5), acceptance-auditor (8, #5 retracted, #9 note). All launched together; all returned.

## PATCH (fix round 1 — operator: fix all incl LOWs rounds 1–2)
- P1 never-throws: `deps.runMeta`/`deps.botTurnSpendUsd` called unguarded (digest-composer.ts:386-391) — a throwing dep exits outside the 0/1/2 table [edge-case-hunter]
- P2 runVerb: timed-out child never killed (proc leak, one per cron tick); every failure collapses to "timed out"; child stderr dropped (digest-composer.ts:244-250,267) [blind-hunter+edge-case-hunter]
- P3 degrade reason computed then discarded: no digest-snapshot field, CLI reads only exitCode (digest-composer.ts:419+, manager-digest.ts) [blind-hunter+verification-gap]
- P4 derived workKey `w:${runId}` emitted unvalidated; WorkKeySchema accepts whitespace-only remainder (digest-composer.ts:399-404; manager-config.ts WorkKeySchema) [blind-hunter+edge-case-hunter]
- P5 no dedupe of status rows by runId (digest-composer.ts:283-297) [blind-hunter]
- P6 parseRows unbounded rows (digest-composer.ts:115-133) [edge-case-hunter]
- P7 no total wall-clock budget (worst ~25 min) + no crontab coalescing lock (digest-composer.ts:313-367; manager-digest.ts) [blind-hunter+edge-case-hunter]
- P8 fence scanner: misses dynamic import(), export-from, non-recursive, timer-scan skips scripts/ (digest-composer.test.ts:180-191,201,259-267) [blind-hunter+acceptance-auditor+edge-case-hunter]
- P9 snapshot_ms can go negative on non-monotonic clock; log duration hardcoded 0 beside real snapshot_ms; Date.now vs deps.now split (digest-composer.ts:363,421,459) [blind-hunter+edge-case-hunter]
- P10 CLI refusals untested via real binary: --driver≠exedev, unreadable config, status-unavailable exit-1 path [verification-gap+blind-hunter]
- P11 gatewayBaseUrl accepts any non-empty string (manager-config.ts:93) [blind-hunter]
- P12 runMeta botIds never cross-checked vs config/bot- prefix (digest-composer.ts:386-391) [blind-hunter]
- P13 fakes: duplicate addBot unguarded; only first minted token checked vs pin; near-miss prefix boundary unpinned by a test (home-seam-fakes.ts:173-181,191-192) [blind-hunter+acceptance-auditor+edge-case-hunter]
- P14 test hygiene: tautological assertions (home-seam.test.ts:119; manager-e2e.test.ts:101-102); DepsOpts.throwing + costLedger-throw + malformed-stdout branches untested; PARK_THRESHOLD drift tripwire missing; e2e never renders a manager-associated digest-run line end-to-end [verification-gap+acceptance-auditor+blind-hunter]

## DEFER (documented rulings — not code changes)
- D1 AC5 letter ("required on manager-associated lines") vs absent-on-missing-gateway-figure: absent stands — the story's own absent-not-0 discipline + INV-MGR-4 (unfunded turn = refusal) make the absent rendering the honest one; document in Dev Agent Record.
- D2 fleet_spend_micro_usd omitted on ledger-read failure though schema lists it unconditioned: same absent-beats-fabricated ruling; documented.
- D3 exit-6 derived from the composer's `fleet result` child rc: surface-fact documented in code (no record-side carrier exists); record-side producer (A2+) supersedes; verif confirmed exit 6 is a real result-verb table code.
- D4 helper duplication across suites (blind#14): driver-level extraction in round 2 (mechanical, multi-file).
- D5 crontab.factory does not carry the digest line: operator-owned deploy config; the story ships the line documented in the CLI header (A5 precedent). Handoff note.

## FALSE (rejected on refutation)
- F1 composeDigest throws on missing attempt record (blind-hunter#1): deriveAttemptLadder catches dangling ledger ids internally (src/fixloop/escalation.ts:184-189 → orphaned arm); throwingRead's throw never escapes deriveAttemptLadder's map.
- F2 NaN ceiling dies as generic schema-invalid, never the named refusal (blind-hunter#11b): the config path is JSON.parse-only; JSON cannot carry NaN; the shape error is unreachable from real input.
- F3 isHomeBackedAgent semantics invented (acceptance-auditor#5): RETRACTED by the reviewer after checking S02b — predicate verbatim from the merged seam text.
- F4 edge-case-hunter's origin-compare fix for the gateway pin: the as-written S03b semantics IS startsWith; changing it violates AC6. Boundary gets a pinning test instead (P13).
