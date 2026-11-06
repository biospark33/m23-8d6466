# A1 bmad-code-review Round 2 — triage (2026-10-16)

Layers: blind-hunter (16), edge-case-hunter (11), verification-gap (4), acceptance-auditor (6). All launched together; all returned. Verif audited round-1 fix claims: all real except malformed-stdout tests (never written — fixer-A overclaim, driver-confirmed by grep).

## PATCH (fix round 2)
- R2-1 botId vocabulary unguarded: meta.botId accepted on any non-empty string, no `bot-` prefix check (digest-composer.ts:784) [blind]
- R2-2 budget reason reaches no channel on composed-with-cuts: budgetNote dropped; CLI prints reason only on status-unavailable (digest-composer.ts:857-860; manager-digest.ts) [blind]
- R2-3 invalid stamped workKey silently swapped to derived — no counter/marker (digest-composer.ts:793-812) [blind]
- R2-4 NaN figures serialize as null: spend guards lack Number.isFinite (digest-composer.ts:767-772,786-791) [blind+edge]
- R2-5 result-verb failures (timeout/fail) never counted/rendered (digest-composer.ts:473-489) [edge]
- R2-6 marks pushed before a skipped run's workKey invalidation → digest-escalation references a line that does not exist (digest-composer.ts:526-538) [edge]
- R2-7 malformed status stdout branch untested despite built statusStdout hook (digest-composer.test.ts:64) [verif+blind]
- R2-8 damaged-readRecord branch untested (DepsOpts.throwing dead) (digest-composer.test.ts:1430) [blind+verif]
- R2-9 fence: misses side-effect import form (audit: empirically verified regex miss), non-relative src/fleet forms, excludes scripts/manager-digest.ts; header overclaims side-effect coverage [audit+blind+edge]
- R2-10 status-vocabulary literals (FLEET_ROW_ID + 3 states) have no drift tripwire — status.ts rename would emit phantom run lines [verif+audit]
- R2-11 WorkKeySchema accepts control chars; composer comment overclaims protection [blind+audit]
- R2-12 CLI resolveRunsDir/mkdirSync/lock-claim throws escape the 0/1/2 exit table → unhandled rejection [blind+edge]
- R2-13 binary e2e legs without QDS_RUNS_DIR contend on the repo's real lock + write outside tmp (manager-e2e.test.ts) [blind+audit+edge]
- R2-15 result_ms can go negative on backward clock (digest-composer.ts:483) [edge]
- R2-16 row cap checked only after full parse — cheap pre-parse line-count check first [edge+blind]
- R2-17 non-string fixAttemptRunIds member silently skips the fixloop leg — no counter (digest-composer.ts:453-462) [edge]
- R2-18 gatewayBaseUrl accepts embedded credentials (https://user:pass@host) — secret rides config + echoes in refusal stderr (manager-config.ts:193-199) [edge]
- R2-19 bots_aggregated counts only bots with a gateway figure, not distinct associated bots — counter disagrees with line botIds [blind]
- R2-20 typeof isHomeBackedAgent tautology survives (home-seam.test.ts:2561) [blind]
- R2-22 scanner duplication + G-scan walks all src/** (hostage scope): extract shared scan helpers, scope to src/managers/** + scripts/manager-digest.ts — driver-level after fixers [blind; D4 from R1]

## DEFER (rulings recorded)
- D6 binary-level manager-line absence: CLI hardwires runMeta=undefined — A1's truth (no producer until A2); in-process e2e leg proves the rendering; ruling recorded, not a gap.
- D7 DOD "fake journal shows no bot turn reaching approve/dispatch" — vacuous by construction (fakes have no such surface); accepted-vacuous, recorded.
- D8 story's `fixOutcome` citation stale — real surface is evaluateCeilings; story-text drift, recorded; do NOT mint a fixOutcome.
- D9 byte-cap on child stdout: pre-parse row-count check (R2-16) + 30 s verb deadline bound the exposure; upgrade path is a streaming capped read — deferred.
- D10 8 KiB skeleton fallback branch unreachable today (all cap-able fields string-capped) — kept deliberately as the line-budget backstop; accepted-unreachable, recorded.

## FALSE (rejected on refutation)
- "Production digest rests on undocumented QDS_LOG_VERBOSE" (blind): log.ts mutes only under NODE_ENV=test (log.ts:31); production cron is audible with no env. The e2e sets it only because tests run under NODE_ENV=test. [verif independently confirmed]
