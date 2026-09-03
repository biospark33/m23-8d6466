# PR 116 Code Review — Triage (2026-08-17)

Sources: blind-cli, blind-engine, blind-tests, edge-cli, edge-engine, edge-tests, auditor2 (clean — all ACs pass).

## Patch (grouped by file cluster for fix waves)

### W1: cli-anything/src/runner.ts + watchdog.ts (+ their tests)
- P1 [blind+edge BLOCKER] Abort check→addEventListener race in runner abortTeam setup — re-check signal.aborted after addEventListener
- P2 [blind BLOCKER] abortSignal listener not removed in removeSignalHandlers; abortTeam must guard `settled` BEFORE killTree (no double-kill)
- P3 [blind+edge BLOCKER] Watchdog kill attribution TOCTOU — natural exit between escalation decision and SIGTERM; killOrigin only after kill succeeds, re-check liveness on catch
- P4 [blind BLOCKER] watchdogKilled/killOrigin async race with overflow precedence check — make escalation set killOrigin synchronously before callback
- P5 [edge HIGH] Grace-timer SIGKILL pgid-reuse hazard — before SIGKILL, verify original child pid still alive; skip if dead
- P6 [edge MED] Sampler permanently unwatchable on single transient ps failure — require ~3 consecutive failures
- P7 [edge MED] Partial output mid-cap split + decoder.end() skipped when capped — flush within cap at finalize
- P8 [blind MED→verify] Windows watchdog silent — verify logged; add one-line notice if not
- P9 [blind MED] Linux `ps -e` O(N) — document ceiling with comment
- P10 [edge MED→verify] Spawn-error settle exit facts nulls — verify intentional (spawn error distinct), document or fix
- P11 [edge-tests] watchdog.test timing 275ms flake — relax assertion / bump sleep
- P12 [edge-tests] watchdog.test bash `$!` order-of-operations race — verify fixture, fix
- P13 [tests] rmSync silent cleanup in afterEach — console.warn in catch (dispatch-task.test, roster-adapter.test)

### W2: cli-anything/src/merger.ts + types.ts + merger.test.ts
- P14 [edge HIGH] truncateWithSuffix garbage ("[truncat") when suffix > maxLength — guarantee suffix always fits / fixed marker
- P15 [blind HIGH] partialOutput 10000+suffix > 10000 contract — verify truncateWithSuffix budgets suffix inside cap; fix or fix JSDoc
- P16 [edge MED→verify] partialOutput "" coerced to null — verify contract intent; fix or document
- P17 [blind HIGH→verify] opts.summary fallback field not in interface — verify; fix if real
- P18 [blind+edge] EXIT_STATUSES/union divergence — make type derive from array (`typeof EXIT_STATUSES[number]`) in cli types.ts
- P19 [edge-tests HIGH] merger.test match?.[1] .toBeDefined weak — pin exact value
- P20 [edge-tests HIGH] merger.test contradictory type-erasure comment — fix comment
- P21 [edge-tests MED] /testsExecuted/ regex too generic — pin invariant message
- P22 [edge-tests LOW] JSON.stringify deep-equal → toEqual; redundant `in` assertion; EXTENDED_KEYS sorted assumption

### W3: src/phase-engine (dispatch-task.ts, team-event-adapter.ts, roster-adapter.ts, manifest.ts, types.ts)
- P23 [blind BLOCKER] Null byte in changedFiles/artifacts paths — reject \0 (and control chars)
- P24 [edge HIGH] UNC backslash paths bypass absolute check — reject `\`
- P25 [edge MED] Empty path "" passes validation — reject empty segments
- P26 [edge MED→verify] validateArtifacts isAbsolute unreachable — verify, remove dead branch or keep as defense-in-depth with comment
- P27 [blind BLOCKER] Unknown worker status defaults "success" — fail-safe default instead
- P28 [edge MED] Duplicate merged events silently overwrite — first-wins guard
- P29 [edge MED→verify] Events after merged still processed — verify design intent, document or guard
- P30 [blind HIGH] Bun parser requires both pass AND fail lines — accept either, missing→0
- P31 [blind MED] dispatchSubTimings spread unvalidated — whitelist the four keys
- P32 [blind MED→verify] comsInitError read from raw event instead of adapted — unify
- P33 [blind HIGH] Manifest unlink silent failure — warn on stderr
- P34 [blind LOW] PhaseSubTimings undefined-vs-zero contract — JSDoc
- P35 [blind MED] pipeline-run.ts rootDir comment/code mismatch — verify + fix comment

### W4: src/phase-engine/phases/test-results.ts + tests/phase-engine/test-results.test.ts
- P36 [edge HIGH + blind HIGH] AbortSignal race check→addEventListener in runTestCommand — re-check after registration
- P37 [blind HIGH] Abort listener leak on exception paths — try/finally listener lifecycle
- P38 [blind MED] Jest parser test same counts on Test Suites vs Tests lines — asymmetric counts
- P39 [blind BLOCKER + edge MED] Env restore: prevAnthropic empty-string edge + assignment-vs-delete — restore exact unset/empty semantics

### W5: engine tests hardening (dispatch-task.test.ts, team-event-adapter.test.ts, roster-adapter.test.ts)
- P40 [blind BLOCKER] /worker/i vacuous match — pin assertion to confinement message
- P41 [edge HIGH] roster-adapter toThrow() without message — pin /worker|too many/i
- P42 [edge HIGH] delete-vs-undefined comment misleading — fix comment
- P43 [blind HIGH] Redaction changedFiles coverage gap — add test
- P44 [blind HIGH→verify] fixture stream test doesn't exercise adaptTeamEvent — verify, fix if real
- P45 [blind MED] Symlink artifact test content pin
- P46 [blind MED] Output-cap test comment math — fix comment
- P47 [edge LOW] toHaveLength(12) — comment F6 invariant
- P48 [edge LOW] "immediately after start" test name — rename

### W6: fixtures + misc
- P49 [edge HIGH→verify] warren fixture big_cost 60s sleep hang — verify test teardown; shorten if needed

## Dismissed (noise / false positive / by design)
- writeFileSync-throw "false pass" x2 (throw = test fails, not vacuous pass)
- rosterPath pre-validation (loadRoster realpath confinement exists — DF1.5)
- workerRoles<=3 early check (delegated to TeamManifestSchema + refuse catch — by design)
- non-English / exotic test-format fail-closed (documented fail-closed contract)
- QDS_TEAM_RUNNER case-sensitivity (spec: exact "local")
- mkdirSync fail-fast on bad runRoot (intentional fail-fast)
- manifest 64-bit entropy (sufficient)
- all roles same prompt (spec design — single taskBrief)
- manifest.ts roster-existence schema check (runtime domain)
- µ$ rounding precision (documented micros contract)
- effectiveCeiling Infinity (clamped by Math.min)
- artifact non-string redact (Zod-validated upstream)
- ambient env snapshot race, readdirSync race, mkdtempSync platform, Windows coverage gap, module state on crash (framework/environment noise)
- loop-generated tests shared assertion (it() name carries value)
- partialOutput-null-on-success "implementation detail" test (is contract now)
- observer-throw doc, type-narrowing clarity (no behavior change)

## Counts
- decision_needed: 0
- patch: 49
- defer: 0
- dismissed: 19
