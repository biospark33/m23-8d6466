# A1 bmad-code-review Round 3 (confirmation) — triage (2026-10-16)

Layers: blind-hunter (18, #1 withdrawn), edge-case-hunter (6), verification-gap (4, #1 retracted with source verification), acceptance-auditor (verdict: NO AC VIOLATIONS; all six ACs + DOD e2e PASS; 3 LOW notes, no action).

## PATCH (final batch — one fixer, all files)
- R3-1 stale lock must not coalesce to exit 0 (RunLockedError.stale, run-lock.ts:64) → pre-flight exit 3 with rm hint; live-held lock still coalesces [edge]
- R3-2 mid-poll composeDigest rejection: own diagnostic + exit 1, never the exit-3 label (belt; never-throws empirically proven) [edge]
- R3-3 approvalsParked/fixloopsActive move post-workKey-gate (align with marks + bots_aggregated) [blind+edge]
- R3-4 botId guard align to /^bot-.+$/ (bare "bot-" rejected like config does) [blind]
- R3-5 non-run rows counter (orphan/(fleet)/listUnavailable/recordsSkipped drops counted) [blind]
- R3-6 fleet_spend_micro_usd gated on CostView.hasEvents + finite (no-events → absent, never 0; dep-boundary coverage of absent-not-0) [blind+verif#2]
- R3-7 dedup comment: "last occurrence (fleet lists newest-first)" [blind]
- R3-8 contract pin: dangling attempt id → composed (empirically proven; pins the ladder's internal catch) [verif, retracted-as-gap, kept as pin]
- R3-9 stderrTail redaction pin (secret pattern absent from reason) [verif]
- R3-10 truncation missing-createdAt tiebreak pin (NEGATIVE_INFINITY sentinel) [verif]
- R3-11 fleetCliInvoker killTree + happy-path invoker test [blind+edge]
- R3-12 result-verb timeout classification test [blind]
- R3-13 CLI argv flag-as-value refusal (--driver --config → "flag requires a value") [blind]
- R3-14 early-exit drain rationale comments [blind]
- R3-15 status.ts tripwire regex hardening + multi-match guard [blind]
- R3-16 e2e captureInto chained restores [blind]
- R3-17 e2e unopenable-ledger leg asserts fleet_spend_micro_usd absent on stdout [verif]
- R3-18 gatewayBaseUrl: trim/control-char + query/fragment-secret refusals [edge]
- R3-19 fakes: double writeProfileTokens refuses (profile_tokens_exist), mirrors reserveBudget [blind]
- R3-20 composer header AC2 wording → "direct imports" (static import fence letter) [blind#5]

## DEFER (rulings)
- D12 transitive fleet imports through an allowed dep: AC2's letter is the static import fence over src/managers' own imports; transitive reach rides each dependency module's own story invariants (fixloop/byte-identical etc.). Header wording aligned (R3-20). No dep-walk machinery.
- D13 digest-escalation carries {kind, runId|approvalId} — the story's own contract field set; workKey join happens via the run's digest-run line. No field added.
- D14 config-validated-then-discarded: the composer is config-agnostic by contract (digest = read-only fleet surfaces); the prefix guard bridges the ADR-RUN-2 D1 vocabulary; config threading to the digest is A2's surface (runMeta producer).
- D15 full fixture-helper extraction (fakeCli/costView/record/event): divergent needs between suites (hang/statusRc variants); extraction cost > benefit. scan-helpers.ts was the shared-by-three case; this one is shared-by-two with drift tolerated and now commented.
- Audit LOW notes (no action): degraded-snapshot honest zero counters vs overbroad CLI comment wording (spend figures are the absent-not-0 scope, honored); e2e gateway reader returns ceiling as spend (asserted on reader, never rendered); snapshot→chat hand-off deferred to A2/Z3 by the story itself.
- f2A ruling: rejected botId drops its stamped workKey too (untrusted association = untrusted stamp).

## FALSE (rejected)
- Ladder-crash claim (R3 blind#1 + verif#1): deriveAttemptLadder catches dangling ledger ids internally (src/fixloop/escalation.ts:184-190); empirically proven (composeDigest with a ledger naming a missing id → composed, exit 0, all events). Verif retracted with source verification; blind withdrew.
- "Production cron needs undocumented QDS_LOG_VERBOSE" (R2 blind#8, carried context): log.ts mutes only under NODE_ENV=test (log.ts:31).

## ROUND DECISION
Three review rounds run (operator cap). After this final patch batch: stop if only LOWs remain — the batch IS the lows+meds; R3 audit found zero AC violations. Reviews end here.

## Post-PR amendment (2026-10-16)
- **D15 CLOSED** (operator challenge): fixture-helpers extraction landed as ed43c60c on PR #434 — union interface reproduces the composer superset verbatim, e2e rewired import-only, expect-count parity 232/232 + 100/100 proven, 109/109 suites + tsc + lint green. D4/D15 are no longer open debts; the scan-helpers + fixture-helpers modules close the one-copy principle for every duplicated fixture in the manager suites.
