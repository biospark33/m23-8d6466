# DF-v5 Pre-Dev Adversarial Review (Pre-Mortem Campaign)

**Date:** 2026-08-12
**Branch:** docs/dark-factory-v5-design (PR #101)
**Scope:** 31 stories in `_bmad-output/sprint-artifacts/dark-factory-v5/stories/` (DF1–DF6)
**Protocol:** ≥3 pre-mortem passes — Pass 1 adversarial scan → fix waves → Pass 2 fresh-eyes verify → fix → Pass 3 final verify

## Status Dashboard

| Pass | Status | Findings (B/H/M/L) | Resolved |
|------|--------|--------------------|----------|
| Pass 1 — initial scan (6 reviewers) | ✅ DONE | 121 (15/42/51/13) | — |
| Fix wave 1 | ✅ DONE | +8 new (1H/4M/3L, all fixed) | 129/129 |
| Pass 2 — fresh-eyes verify | ✅ DONE | 90 (4/22/43/21) | — |
| Fix wave 2 | ✅ DONE | +8 new (0B/3M/5L, all fixed) | 98/98 |
| Pass 3 — final verify | ✅ DONE | 27 (1/6/9/11) | 27/27 |

## Findings

### Pass 1 — DF1 (R-DF1) — 19 findings: 3 B / 5 H / 8 M / 3 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF1-P1-01 | df1-2 | BLOCKER | AC1 vs INV-5 | AC1 `passed = violations.length === 0` contradicts INV-5 (zero-check report must be `passed:false`). | AC1 → `passed = checks.length > 0 && violations.length === 0`; add DoD negative-control test for empty gate. |
| ✅ | DF1-P1-02 | df1-6 | BLOCKER | AC5/Overview/Trigger/epic index | Three-way contradiction on `QDS_TEAM_RUNNER` unset (accept-default-local vs refusal); code default is `warren`. | Refuse-on-unset: AC5 → unset or non-`local` refuses pre-spawn with `exitStatus:"logic"`; fix Overview to "accepts `local` only". |
| ✅ | DF1-P1-03 | df1-6 | BLOCKER | AC1/Tech Notes/DoD | AC1 mandates `testResults`/`testsExecuted` but no producer exists anywhere in runtime; no AC says who computes them; DF5.1 reads the field. | Add AC6: engine runs manifest `testCommand` host-side, parses counts; no `testCommand` → `{passed:0,failed:0}, testsExecuted:false`. DoD tests both branches; add `testCommand?: string[]` to DF1.1 `PhaseSpec`. |
| ✅ | DF1-P1-04 | df1-1 (+df1-2) | HIGH | E2E/DoD vs df1-2 AC4 | df1-1 e2e fixture ("second code phase throws") breaks once df1-2 AC4 makes non-zero exit of `code` phase data-not-throw. | df1-1 e2e → one `code` phase + one `engineer` phase whose body throws; Tech Note: code-phase non-zero exit is data (DF1.2 AC4). |
| ✅ | DF1-P1-05 | df1-2 | HIGH | E2E vs DoD MANDATORY e2e | E2E Slice (no GateReport, no gate_fail) mutually exclusive with mandatory DoD e2e (persisted gate_fail). | Rewrite E2E Slice to registered-`commandGate` path (4 checks/1 violation, gate_fail persisted, phase fail); keep no-gate case as AC4 unit test. |
| ✅ | DF1-P1-06 | df1-1 | HIGH | Tech Notes vs AC4/INV-3 vs df1-3 | `maxDurationMs` per-phase vs per-attempt ambiguity; admission formula omits parse-retry multiplier (real ceiling 3×). | Declare per-attempt semantics; formula → `sum((retries+1)*(PARSE_FIX_ATTEMPTS+1)*maxDurationMs)+phases.length*5000 <= runBudgetMs <= callerBudgetMs`; INV-3 timer "armed per attempt". |
| ✅ | DF1-P1-07 | df1-4 | HIGH | Dependency edges | Declares only DF1.1 predecessor but E2E/DoD/AC1 require DF1.2 (gate_results, envelopes). R5 graph same error. | Add DF1.2 as predecessor + amend Wiring-closed sentence (or scope e2e to lifecycle events only). |
| ✅ | DF1-P1-08 | df1-1 (+df1-2, df1-6) | HIGH | INV-1+INV-5 | `O_NOFOLLOW` relative-open walk impossible in Node/Bun; read literally, engine refuses to run and own e2e can't pass. Inherited into df1-2 INV-3, df1-6 INV-2/INV-5. | Append permitted equivalent: `fs.realpath` + prefix re-assert + read through resolved fd, never re-open by string (per p1-6:113). DoD line naming shipped mechanism on bun 1.2.22. |
| ✅ | DF1-P1-09 | df1-3 | MEDIUM | INV-3/Tech Notes | µ$ integer accumulator vs `runner.ts:707` USD-float budget guard; no owner for conversion. | Tech Note: µ$ internal; convert once at phase-engine→runner call site (`usd = micros/1_000_000`); DoD unit-boundary test. |
| ✅ | DF1-P1-10 | df1-9 | MEDIUM | Files to Modify/INV-2 | Schema is `TeamRoleSchema` (`.strict()`) in `cli-anything/src/types.ts`, not `manifest.ts`; types.ts absent from Files to Modify → `lean:` key hard-fails. | Add `cli-anything/src/types.ts` to Files to Modify; amend Seams note. |
| ✅ | DF1-P1-11 | df1-5 | MEDIUM | Infra Prereqs | `yaml` dep only in cli-anything/package.json; new `src/phase-engine/roster/` import relies on hoisting. | Add Infra Prereq row: root package.json `yaml@^2.9.0`; add `package.json` to Files to Modify. |
| ✅ | DF1-P1-12 | df1-5+df1-6 | MEDIUM | Schema note/Overview | Roster `{provider, model}` pair vs `TeamRoleSchema` single `"provider/model"` string; no story owns adapter. | DF1.6 DoD roster→manifest adapter test (round-trips through `splitRoleModel`); name adapter fn in Files to Modify. |
| ✅ | DF1-P1-13 | df1-6 | MEDIUM | AC1/DoD | New MergedOutput fields' placement unspecified (top-level vs `result.*`); `summary` collides with existing `result.summary`. | Tech Note: new fields top-level siblings; `result.summary` copied to top-level by `buildMergedOutput`, `result` unchanged. |
| ✅ | DF1-P1-14 | df1-8 | MEDIUM | INV-RUN-1/AC3 | Idempotency rationale wrong (pk is `request_id`, index adds no uniqueness); same requestId+different repoSlug behavior unspecified. | AC3: mismatch → structured `RequestIdRepoMismatch` error; rewrite INV-RUN-1 (index is for query-backing). |
| ✅ | DF1-P1-15 | df1-6 | MEDIUM | Story Points | 5 pts under-scoped vs 10 files/5 ACs/8 DoD items. | Re-size to 8 (DF1 → 32 pts) or split DF1.7. |
| ✅ | DF1-P1-16 | df1-8 | MEDIUM | epic index | Epic index lists P1.2 hard dep; story removed it. | Index → "Depends on: DF1.4, DF1.6 (P1.2 soft dep only — see story)". |
| ✅ | DF1-P1-17 | df1-6 | LOW | AC1 | Citation "verbatim from p1-6:32" wrong for `testsExecuted` (introduced :62). | Cite "p1-6:32, with `testsExecuted` carried from p1-6:62". |
| ✅ | DF1-P1-18 | df1-9 | LOW | Trigger Surface | Cites `team-lead-driver.test.ts` as existing; it's new. | Mark cell "(**new**)". |
| ✅ | DF1-P1-19 | df1-5 | LOW | INV-1 | "No src/→cli-anything import edge" sentence reads as layering rule siblings break. | Reword: "…because it needs none; DF1.1/DF1.2 establish that edge". |

**DF1 verified-correct (do not regress):** all DF1.6/DF1.9 code citations resolve exactly; F6 proof numbers real; P1.x verbatim ancestry checks out; DF1.9 INV-1 `writeArtifactAtomic` critique accurate; DF1.4 MIGRATIONS/SCHEMA_INDEX_DDL two-list split consistent with DF1.8.

### Pass 1 — DF3 (R-DF3) — 21 findings: 4 B / 7 H / 9 M / 1 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF3-P1-01 | df3-5 (+df3-1) | BLOCKER | Overview/AC1/Infra/DoD | DF3.5 built on `src/fleet/verbs.ts`/`listVerbs()` "already shipped by DF3.1" — DF3.1 never creates it; appears in no story's Files-to-Modify. | DF3.1: add `src/fleet/verbs.ts` + test to Files-to-Modify; add AC6 (listVerbs shape + help renders from it + bidirectional coverage test); DF3.2/DF3.4 note new verbs register through it. |
| ✅ | DF3-P1-02 | df3-4 | BLOCKER | AC5/E2E/Infra/Files | Host→in-box steering transport owned by nobody; attach verified only against test double; "wiring closed" false. | Name transport in DF3.4 Tech Notes (driver.exec append to /run/steering/inbox.ndjson; drain at 3 solicitation points; ack file; 30s timeout → attach-not-acked); add src/phase-engine/steering.ts to Files; add DF2.1 dep; add live-fixture AC. |
| ✅ | DF3-P1-03 | df3-2 | BLOCKER | AC7/Tech Notes/DoD | `rank` score undefined — carries P1.4 tie rule (0.1) without formula; P1.4's `summaryQuality` term references nonexistent `compare` phase. | AC7: `score = testPassRate*0.6 + uniqueFileCoverage*0.4` per p1-4:92 definitions; breakdown carries exactly those keys; drop summaryQuality (renormalized); DoD fixture test. |
| ✅ | DF3-P1-04 | df3-3 | BLOCKER | AC1 vs DoD vs E2E | AC1 admits steered outcomes differ; DoD+E2E demand byte-identical verdicts vs `--no-resident` control — mutually exclusive. | Split: proceed-only equivalence test (byte-identical) + steered-run invariants test (same phase order, no unearned promotions); rewrite E2E to second form; fix epic line 446. |
| ✅ | DF3-P1-05 | df3-2 | HIGH | AC5/Trigger/Observability | No fan-out record exists — `rank <fanout-id>` and "winner field" name a store no story creates. | Add `.sandbox/fanouts/<id>.json` (O_EXCL, schema given) + `extensions.fanout={fanoutId,arm}` per DF2.1 namespace; DoD exists-after-success/not-after-refusal test. |
| ✅ | DF3-P1-06 | df3-2 | HIGH | AC5 race predicate | `finish(accepted)` is inside-box; host has no completion signal from DF3.1+DF2.6 — race pattern unimplementable. | AC5: host polls `driver.observe(vm)` for `/run/journal/final.json` marker (5s interval, 3.6M ms ceiling); missing marker → `armUnknown`; add DF2.1 dep (+DF1.1 if marker is engine's). |
| ✅ | DF3-P1-07 | df3-6 | HIGH | AC2/INV-BND-2 | "Validated before a box exists" structurally unachievable — engine+manifest live inside the box. | Reword: validated at manifest load inside box, before resident spawn/solicitation; refusal exits `bound-config-invalid`, box alive with evidence. Optional DF3.1 host-side pre-flight AC. |
| ✅ | DF3-P1-08 | df3-6 | HIGH | Dependency edges | Missing hard deps DF1.5 (cost block) and DF2.8 (`runBudgetCapMicros`). | Edges → DF3.3, DF1.1, DF1.5, DF2.3, DF2.8; update epic line 504. |
| ✅ | DF3-P1-09 | df3-3 | HIGH | Dependency edges | DF1.5 roster required by infra prereq + `select_roster` but not declared. | Edges → DF1.1, DF1.5, DF1.6, DF2.2, DF3.1; update epic line 444. |
| ✅ | DF3-P1-10 | df3-4 | HIGH | Deps/Trigger/AC1 | (a) DF2.5/DF2.3 undeclared; (b) DF5.1 precondition undeclared; (c) `requestApproval()` caller exists in no story — no run ever pauses. | Edges → DF3.1, DF3.3, DF2.3, DF2.5, DF5.1; add DF5.1 AC calling requestApproval on green (or move trigger row out-of-scope→DF5.1) — exactly one owner; update epic line 464. |
| ✅ | DF3-P1-11 | df3-6/df3-3 | HIGH | E2E/DoD vs AC3/AC4 | DF3.6 asserts `resident.status:"stopped"`; DF3.3's enum is active\|degraded\|disabled only. | DF3.3 AC5: closed set adds `stopped` (written only by DF3.6 bound enforcement); DoD closed-union assertion. |
| ✅ | DF3-P1-12 | df3-3,df3-6 | MEDIUM | AC5/Tech/INV-BND-2 | Micro-USD field naming drift (`*MicroUsd` vs `*Micros` mixed). | One-line mapping note: persisted fields keep `*MicroUsd`; `*Micros` names are in-memory only; explicit `:=` mappings. |
| ✅ | DF3-P1-13 | df3-6 | MEDIUM | AC2 vs df2-3:116 | DF2.3 chain non-strict ≥; DF3.6 refuses on equality — valid config per DF2.3 refused by DF3.6. | Tech Note: DF3.6 authority, tightens first pair to strict `<`; DF5.5 amends DF2.3 wording (add to repoint list). |
| ✅ | DF3-P1-14 | df3-6 | MEDIUM | AC5/INV-BND-5 | RSS sampling Linux-only (`/proc`); fail-closed kills DF3.3's darwin e2e demo. | Platform-dispatch: `/proc/<pid>/status` Linux, `ps -o rss=` darwin; unwatchable ⇒ not-started only when both fail. |
| ✅ | DF3-P1-15 | df3-2,df3-5 | MEDIUM | Spec Reference | `INK/` alias target checkout absent on this host; cited AC-anchor lines unopenable. | Note alias expansion + clone instruction; R4-external-patterns.md excerpts are binding text. |
| ✅ | DF3-P1-16 | df3-5 | MEDIUM | AC4/DoD pricing lint | Pricing-language lint has no patterns — vacuous or false-fires on required factory-guide sentence. | Fixed case-insensitive pattern set (5 regexes) + single verbatim allowlisted exception. |
| ✅ | DF3-P1-17 | df3-2 | MEDIUM | Admission before mint | Slot-free admission check; nothing enforces single-operator — concurrent fanouts double-admit. | AC8: advisory lock `.sandbox/fleet.lock` (O_EXCL, pid+createdAt, stale 3.6M ms) across admission+mint; second concurrent → `fleet-busy` exit 5; lock-free MUST fail. |
| ✅ | DF3-P1-18 | df3-4 | MEDIUM | AC1 vs df2-5/df5-2 | Pause teardown closes record; DF5.2 later writes `extensions.pr` — writability of closed record undefined. | Tech Note: `extensions` writable after close, 12 core fields not; DF5.2/DF5.3 land on closed record by design; mirror into DF2.1 note via DF5.5. |
| ✅ | DF3-P1-19 | df3-5 | MEDIUM | DoD MANDATORY e2e | Manual Claude Code transcript demo — unautomatable. | `tests/fleet/skill-contract.test.ts` extracts commands from SKILL.md files, runs against fake driver, asserts same runId; transcript is supporting evidence only. |
| ✅ | DF3-P1-20 | df3-4 | MEDIUM | Story Points | 4 pts vs widest AC surface in epic (+transport gap). | Re-size to 6, or split DF3.7 Operator Steering Channel (2 pts). |
| ✅ | DF3-P1-21 | df3-1 | LOW | Exit codes | Exit `4` (run-not-found) never exercised by any AC/DoD. | Extend AC4: unknown runId on status/harvest/teardown exits 4 with structured error, mutates nothing. |

**DF3 verified-correct (do not regress):** ancestry citations resolve (p1-1:47/:52/:126, p1-8:36-39, p1-4:92-97); repo paths clean (`types.ts:79`, `redact.ts:62`, `cli-args.ts:48`); DF3.6 pre-flight projection shape + negative control right; ratio-trap re-spec faithful (absolute µ$ ceiling, schema-scan enforced); DF3.2 isolation and DF3.4 idempotency negative controls correctly adversarial.

**DF3 root cause:** four BLOCKERs share one pattern — artifacts named "already shipped by a sibling" that no story's Files-to-Modify creates (verb registry, attach transport, fan-out record, rank formula). All in v5-S2.

### Pass 1 — DF2 (R-DF2) — 23 findings: 1 B / 11 H / 8 M / 3 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF2-P1-01 | df2-4 | BLOCKER | Tech Notes ceiling order | Ceiling ordering inverted vs DF2.3/DF3.6 (`budget ≤ per-run ≤ key` vs correct `resident < budget ≤ key`); demo config unexecutable (inner controls above outer). | Correct order `residentSpendCeilingMicros < runBudgetCapMicros ≤ runKeyCapMicros`; demo lowers all three (`--cap 50_000`, budget 40k, resident 30k). |
| ✅ | DF2-P1-02 | df2-8 | HIGH | AC3/Tech Notes | Ordering assertion vs per-mint `min(default, remaining)` cap ambiguity — literal impl refuses every remainder-capped mint. | Note (in DF2.8 + DF2.3): ordering evaluated once at config load over configured defaults only; per-mint effective cap exempt. |
| ✅ | DF2-P1-03 | df2-2,df2-3,df2-1 | HIGH | schema fields | Three spellings of run-record fields (camelCase vs `commit_sha`/`key_hash`/`closed_at`) — DF2.2/DF2.3 tests fail against correct DF2.1. | Fix DF2.2 AC1/AC3 + DF2.3 DoD to camelCase; DF2.1 note: snake_case only in DF2.8 SQLite columns. |
| ✅ | DF2-P1-04 | df2-3 | HIGH | DoD MANDATORY e2e | E2e demands closed record with `closed_at` — contradicts AC1/AC3/Tech Notes/E2E (closure is DF2.5's). | Rewrite e2e: open record, `closedAt` unset, keyHash/limit/spend present, key absent from provider list. |
| ✅ | DF2-P1-05 | df2-1 | HIGH | Tech Notes vs DoD | `fixLoop` both registered and required to be "unregistered" in rejection test. | DoD test uses `extensions.telemetry.foo` (rejected) + `extensions.pr.prUrl` (accepted) — allow-list proof. |
| ✅ | DF2-P1-06 | df2-6 | HIGH | INV-1/AC1 | VM ownership tested by run-id grammar `^[a-z0-9][a-z0-9-]*$` — matches nearly any VM; `--yes` destroys operator VMs. | Ownership = generated shape `^[a-z0-9][a-z0-9-]*-\d{8}-[0-9a-f]{6}$` AND a matching `.sandbox/runs/<name>.json` ever existed; else `foreign`. Negative control `steve-devbox`. |
| ✅ | DF2-P1-07 | df2-6 | HIGH | AC1/AC6/Tech Notes | Orphan `sbx-` key has no age test; mint→record write window lets sweep revoke live run's key. | AC7: unmatched key reaped only if provider creation time > staleAfterMs; younger = `paired-pending`; no timestamp → report-only `key-age-unavailable`. Test: mint, sweep pre-record, zero revocations. |
| ✅ | DF2-P1-08 | df2-6 | HIGH | Reap routing/INV-4 | All DF2.3 verbs record-coupled; record-less orphan key has no defined revoke call. | DF2.3 adds `revokeAndVerify(keyHash)` record-free variant; DF2.6 routes orphans there, recorded keys via `teardown(runId)`. |
| ✅ | DF2-P1-09 | df2-6 | HIGH | AC1 make-or-break | Only `paired` defined; `leaked-vm`/`leaked-key`/`stale-record` undefined; per-item class vs per-run action mismatch. | Definition table under AC1 (given); items sharing runId group to one `teardown(runId)` action while each reports its class. |
| ✅ | DF2-P1-10 | df2-8 | HIGH | Tech Notes/AC1 | NOT NULL ledger fields (`run_id`,`repo_slug`,`issue_id`,`role`) have no provenance from DF2.7's CostEvent. | `ingestCostEvent(event, ctx)` with dispatcher-supplied ctx; role from roster, never inferred; missing ctx field = structured error, zero rows; DoD test. |
| ✅ | DF2-P1-11 | df2-8 | HIGH | Trigger row 1/DoD | "box-hour rows from `captureSpend`" is category error — double-counts token spend in priced SUM. | box_hours from record VM lifetime × `boxHourRateMicroUsd`; captureSpend never ingested; DoD single-row + exact-SUM test. |
| ✅ | DF2-P1-12 | df2-7 | HIGH | AC1 negative control | Running-total branch makes negative control unsatisfiable; fixture presupposes delta answer. | Branch AC by probe outcome: delta → final<total fixture; running-total → non-monotone fixture asserting last-wins-with-max; record branch in Dev Agent Record. |
| ✅ | DF2-P1-13 | df2-1↔df2-9 | MEDIUM | Trigger/DoD vs Wiring | DF2.1 says DF2.9 registers OCI driver; DF2.9 defines image only. | DF2.1 trigger row → out-of-scope "v5 §8 step 7 (not DF2.9)"; DoD → "future OCI driver story". |
| ✅ | DF2-P1-14 | epics doc:354 | MEDIUM | DF2.8 header | Epic lists P1.2 hard dep; story removed it. | Epic line → deps DF2.7, DF2.3 with P1.2 soft-dep parenthetical. |
| ✅ | DF2-P1-15 | df2-4 | MEDIUM | Dependency edges | DF2.5 edge missing (AC3 needs teardown six steps). | Edges → DF2.2, DF2.3, DF2.5 (+R5 §3 note: DF2.5 in S1). |
| ✅ | DF2-P1-16 | df2-2↔df2-3 | MEDIUM | INV-4/E2E | Key delivery path+var name unfixed between producer and consumer. | DF2.3 note: `/home/agent/app/.env` mode 0600, single line `OPENROUTER_API_KEY=<key>`; contract for DF2.2 assertions + pi runtime. |
| ✅ | DF2-P1-17 | df2-8 | MEDIUM | Infra Prereqs | `<host_data_dir>` undefined anywhere. | `.sandbox/cost-ledger.db` (0600/0700 per DF2.1); survives box destruction (§6 item 4). |
| ✅ | DF2-P1-18 | df2-2 | MEDIUM | AC1 | "exits with assertion's code" — setup is a driver method returning payload, not a process. | Returns `{ready:false, failedItem, assertionCode, assertions[]}`; script exits with code; only scripts/-level maps to process exit; DF3.1 keeps it in payload. |
| ✅ | DF2-P1-19 | df2-7 | MEDIUM | INV-COST-5 | Per-turn kill unenforceable — `cost` emitted per-subprocess (driver :302/:364), not per-turn. | Restate: granularity per-subprocess; `unpricedTurns>0` blocks next subprocess spawn; per-turn kill is DF3.6's engine-side projection. |
| ✅ | DF2-P1-20 | df2-9,df2-1 | MEDIUM | Story Points | DF2.9 "doc-heavy" 3 pts vs real build/CI/scan surface; DF2.1 3 pts vs driver seam+store+CLI+8 DoD groups. | DF2.9 → 5, DF2.1 → 4 (DF2 → 34), or name the story absorbing the cut. |
| ✅ | DF2-P1-21 | df2-4 | LOW | Tech Notes | Citation df2-1:116 wrong — schema at :119-121. | Fix citation. |
| ✅ | DF2-P1-22 | df2-7 | LOW | DoD Integration | `runner.ts:707` cite wrong for accumulate-compare (:731-732). | "(`:463` fraction, `:515` threshold, `:731-732` accumulate-and-compare, `:707` settle)". |
| ✅ | DF2-P1-23 | df2-5,df2-6 | LOW | Dependency edges | DF2.3 edge only transitive via DF2.2 though verbs called directly. | DF2.5 → DF2.1, DF2.2, DF2.3; DF2.6 → DF2.2, DF2.3, DF2.5. |

**DF2 verified-correct (do not regress):** all DF2.7 code citations resolve; DF2.9 provenance AC accurate (`coms.ts:14-15`, `_provenance`, lint enumerated list); DF2.4's DD-6 P0.4-AC pointer correction right; DF2.5 harvest/teardown ordering strongest spec in epic; DF2.1 greenfield claim holds.

### Pass 1 — DF5+DF6 (R-DF56) — 19 findings: 3 B / 5 H / 8 M / 3 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF56-P1-01 | df6-1 (+df5-2) | BLOCKER | AC2 push path | DF5.2 pushes `qds/<run-id>` for its own runId and refuses existing ref at different sha — fix loop cannot push to PR branch. | DF5.2: export `pushVerifiedSha(runId, {targetRef})`; non-default targetRef must be fast-forward (`merge-base --is-ancestor`); `openPullRequest` never accepts non-default. DF6.1 AC2 uses it + DoD fast-forward assert. |
| ✅ | DF56-P1-02 | df6-1 | BLOCKER | E2E/Infra/Trigger | "Wiring closed" false — depends on P1.18 (draft) webhook receiver on files that don't exist; DD-1 gives no webhook ingress. | AC3 verdict via polling `gh pr checks --json` (30s, ceiling = attempt 15-min timeout); webhook out-of-scope v5.0; `scripts/fix-run.ts --pr <n>` sole trigger; delete "no sibling required" sentence. |
| ✅ | DF56-P1-03 | df6-1 | BLOCKER | AC2/AC3/E2E | Fix push gated by DF5.2 INV-PR-5 (approval required) but DF6.1 has no approval step — silent invariant violation or unclosed E2E. | DF6.1 AC2: each fix attempt requires own ApprovalRecord decided after that run's ReverifyReport; `fleet approve` in e2e; add DF3.4+DF5.1 edges. (Alt: DF5.2 AC carving pushVerifiedSha out of INV-PR-5 with stated residual risk.) |
| ✅ | DF56-P1-04 | df5-4 (+df5-2) | HIGH | C8/C10 | Clauses need P1.3 mirror index + issue correlation (draft, out of slate) — gate can never go green. | C8 → asserts labelled `Issue:` line presence/shape (value may be `unresolved`); C10 → run-keyed total (see -07); clause-map note re P1.3. |
| ✅ | DF56-P1-05 | df5-4 | HIGH | C6/INV-GATE-4 | Ordering proof needs host PR-creation timestamp DF5.2 never writes; GitHub server clock unreliable. | DF5.2 `extensions.pr` gains `createdAt` (host ISO-8601, pre-POST); C6 compares host clocks only. |
| ✅ | DF56-P1-06 | df5-3 | HIGH | Trigger row 3/Files/DoD | CI chain-verification asserts against host-only artifacts absent on GitHub runners. | Move CI row out-of-scope; drop `.github/workflows/audit-chain.yml`; delete CI half of Contract DoD. |
| ✅ | DF56-P1-07 | df5-3 (+df2-8) | HIGH | Infra row 2/hop 3 | Hop 3 run→cost uses issue-scoped `readIssueCost`; issue-less runs break the chain. | DF2.8 DoD adds `readRunCost(runId)`; DF5.3 hop 3 + DF5.4-C10 use it. |
| ✅ | DF56-P1-08 | df5-2,df6-1 | HIGH | Infra token / AC1 | PR author identity unspecified; repo rule binds CodeRabbit to biospark33 — wrong author → no bot review → DF6.1 trigger never fires. | `.factory/repos.json` entries gain `authorLogin`; preflight asserts token login matches, refuse+security-event on mismatch; DF6.1 infra row verifies bot bound to author before e2e. |
| ✅ | DF56-P1-09 | df5-1 | MEDIUM | Deps/AC2/Observability | DF1.1/DF2.1/DF3.1 undeclared; `baseSha` source unnamed. | Edges → DF1.1, DF1.2, DF1.6, DF2.1, DF2.5; Infra row: `baseSha` = record `commitSha`; missing → `error`, no worktree. |
| ✅ | DF56-P1-10 | df5-1 | MEDIUM | AC2/Tech Notes | Host-pinned manifest location unnamed — if from target repo it's agent-authored one PR back. | Plan resolves from operator's `.factory/pipeline.json` keyed by repoSlug, never from target repo/harvest; missing entry → `error` `no-host-plan`. |
| ✅ | DF56-P1-11 | df5-2 | MEDIUM | E2E note vs Infra row 6 | `issue: unavailable` vs `issue: unresolved` literals drift. | Pick `unresolved` everywhere (AC2, Infra, DF5.4-C8). |
| ✅ | DF56-P1-12 | df5-4 | LOW | Tech Notes budget | "Three waves" wrong — preflight is separate barrier; 4 waves = 240s vs 300s. | Restate: 1 preflight + 3 main waves = 240s, 60s margin. |
| ✅ | DF56-P1-13 | df5-3 | MEDIUM | Files/Deps | Edits four DF2.x-owned files without edges; double-implementation risk. | Full predecessor list + note: edits are single-line `recordAuditLink()` emits, no logic/signature changes. |
| ✅ | DF56-P1-14 | df5-3 | MEDIUM | AC5 | "No approval required" as N/A hop-8 contradicts INV-PR-5. | Replace example with box_hours-absent hop; hop 8 never N/A for PR-bearing run — absent approval = broken. |
| ✅ | DF56-P1-15 | df6-1 | MEDIUM | AC3/INV-4 | `attemptSha` undefined for multi-commit appends; intermediate SHAs break equality check. | Tech Note: attemptSha = branch head after push (`rev-parse`); any other sha (incl. intermediates) rejected pre-transition. |
| ✅ | DF56-P1-16 | df6-1,df5-3,df5-4 | MEDIUM | Sprint headers | S3 load understated (P1.18 carry-in unaccounted; df5-5 sprint drifts S2/S3); DF6.1 4 pts dishonest vs surface. | Restate S3 composition; reconcile df5-5 sprint; re-point P1.18 (or fold into -02 fix); DF6.1 → 6 or split DF6.2. |
| ✅ | DF56-P1-17 | df5-3 | LOW | Infra row 1 | "bun 1.2.22" stale (host 1.3.13). | "bundled with the project's bun toolchain", no version literal. |
| ✅ | DF56-P1-18 | df5-1 | LOW | Tech Notes | `types.ts:79` stale for ExitStatus (now :84). | Fix citation. |
| ✅ | DF56-P1-19 | df6-1 | MEDIUM | INV-3 | Credential-in-box abort has no mechanism/test — decorative invariant. | Setup gate asserts `git config --get-regexp '^credential\.'` empty + GH_TOKEN/GITHUB_TOKEN unset; hit aborts pre-brief; DoD test. |

### Pass 1 — DF4 + DF5.5 (R-DF45) — 22 findings: 3 B / 8 H / 10 M / 1 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF45-P1-01 | df4-1 | BLOCKER | Files/Infra | `visualizer/` doesn't exist; SSSF source absent from machine; no upstream URL/SHA/vendoring step/MIT attribution scoped for ~4,656 vendored lines. | Rename "Files to Create/Modify"; Infra row pinning upstream repo@SHA + LICENSE.upstream + PROVENANCE.md; AC0 (clean-checkout vendoring + NOTICE sweep input); DF2.9 edge or stated exclusion. |
| ✅ | DF45-P1-02 | df4-1 | BLOCKER | AC3 vs DoD | Absent/locked trace: AC3+INV-5 say fatal startup exit; DoD says health-degraded + process stays up. Epics sides with DoD. | Split DoD by phase: startup → exit non-zero (INV-5); runtime (removed/locked after start, pre-migration column) → health degraded, data routes 500, stays up. Fix epics §DF4.1 bullet 3. |
| ✅ | DF45-P1-03 | df5-5 | BLOCKER | AC1 make-or-break | Grep set includes p0-7 which carries 4 un-repointed P1.1 occurrences (L55 asset comment, L136×3) absent from amendment A — AC1 can never return zero. | Add p0-7 row to amendment A (L136 repoint, L55 annotate `(now DF3.1)` per provenance rule); reconcile with AC3's "no P0.7 asset modified". |
| ✅ | DF45-P1-04 | df5-5 | HIGH | AC1/Tech Notes | "Amendments A–E" but only A–D defined; E exists as inline tag only. | Define Amendment E (P1.19→DF6.1 in p1-18:50) or fold into A; no lettered amendment left unspecified. |
| ✅ | DF45-P1-05 | df5-5 | HIGH | Sprint header | v5-S3 contradicts epics:661 and R5 §3 (both S2); story's S3 rationale self-refuting. | Restore `v5-S2 (apply after slate IDs frozen)`; trim predecessor line to IDs actually written. |
| ✅ | DF45-P1-06 | df5-5 | HIGH | Overview/AC1/DoD | "11 KEEP files" set silently swaps P0.5 (KEEP, zero hits) for P0.7 (DONE-KEEP); marker-set assertion wrong. | Restate: 11 KEEP stories + P0.7 in scope; P0.5 not amended (zero hits); "11 **amended** files" listed explicitly in AC1/DoD. |
| ✅ | DF45-P1-07 | df4-2 | HIGH | Integration points | Adds call at head of DF2.5's fixed teardown order without DF2.5 edge or owning `src/providers/teardown.ts`. | Add DF2.5 edge + file; AC: stopVisualizer before spend capture, failure logged non-aborting, DF2.5 ordering test passes unchanged. |
| ✅ | DF45-P1-08 | df4-2 | HIGH | AC3 vs INV-3 | `O_EXCL` token mint fails by definition on idempotent second observe. | INV-3: O_EXCL on first mint only; second observe stats existing path (O_NOFOLLOW, 600, owner) and reuses; EEXIST+failed stat = named failure. Add second-call test. |
| ✅ | DF45-P1-09 | df4-1 | HIGH | Security Invariants/AC1 | No DNS-rebinding (Host header) defense; no CORS-absence assertion — standard bypasses of loopback+token posture. | AC1(c): reject non-`127.0.0.1:<port>`/`localhost:<port>` Host with 403 before credential check; INV-1: no `Access-Control-Allow-*` ever, tested on 200 and 401. |
| ✅ | DF45-P1-10 | df4-1 | HIGH | Story Points | 4 pts for vendoring 4k lines + rename + auth layer + CSRF + e2e; R5 calls DF4 weakest estimate; no split valve. | Split DF4.1a (port+workspace+rename, 3) / DF4.1b (auth gate, 3), or re-point to 6 (epic 10); add split valve mirroring SPL-008. |
| ✅ | DF45-P1-11 | df4-1,df4-2 | HIGH | Trigger row 5/AC1 | Prompts route drops `/agents/:agent/` segment from upstream shape without defining replacement; DF4.2 asserts "eight routes" against unpinned list. | Pin shape in DF4.1 (per-agent, or flattened with validated `?agent=` param); enumerate eight routes by literal path once in DF4.1; DF4.2 cites list. |
| ✅ | DF45-P1-12 | df4-2 | MEDIUM | AC1/Tech Notes | Exclusion set vs line arithmetic disagree (SessionsList 96 excluded, App.vue 131 held, figure counts opposite). | Swap set (exclude App/SessionCard/SessionTrace/PhaseDetail = 2,726) or fix figure to 2,691; rationale "≥400 lines DOM-heavy SFC". |
| ✅ | DF45-P1-13 | df4-2 | MEDIUM | AC1/Infra | Bun `coverageThreshold` is global-only; per-glob 90% gate as written inexpressible; no bunfig.toml exists. | bunfig.toml created with coverage config + coveragePathIgnorePatterns; scoped `bun test visualizer/ --coverage`; repo-wide test inherits nothing. |
| ✅ | DF45-P1-14 | df4-2 | MEDIUM | AC1/Files | `models.ts` (29 lines) in coverage glob, unnamed, untested; "545 across six" only sums with it included (516 without). | Add models.test.ts ("seven modules") or ignore-pattern it; fix figure. |
| ✅ | DF45-P1-15 | df5-5 | MEDIUM | E2E/DoD | Marker grep unscoped — literal appears in story file/epics/test; can never equal 11 files. | Scope grep to phase-0/phase-1 stories dirs; sorted output equals 11-path list; same form everywhere. |
| ✅ | DF45-P1-16 | df5-5 | MEDIUM | AC1 | `grep -v 'DF[0-9]'` passes wrong-successor repoints — verifies annotation, not correctness. | Table-driven per-pair test: surviving `P1.<n>` line must match its mapped `DF<x>.<y>` on same line. |
| ✅ | DF45-P1-17 | df5-5 | MEDIUM | Deps/INV-4 | Edge list omits DF1.3, DF1.5 (written by amendment C); lists DF5.4 (written nowhere). | Edges → DF1.3, DF1.5, DF1.6, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1; AC4 precondition = successor IDs appearing in amendments resolve to files. |
| ✅ | DF45-P1-18 | df4-1 | MEDIUM | AC5 | `assertNeverPublic(port)` input contract undefined — port source unnamed anywhere. | Infra: `QDS_VIZ_PORT` default 4600 validated 1024–65535; AC5 restated with signature-assert test; note enforcement is DF4.2's. |
| ✅ | DF45-P1-19 | df4-1 | MEDIUM | Infra row 1 | "No new runtime dependency" false (6 packages enter bun.lock); biome's partial .vue support may no-op lint DoD. | Reword dep claim + NOTICE flow; DoD: biome check visualizer exits 0 or .vue in ignore set with vue-tsc substitute gate. |
| ✅ | DF45-P1-20 | df4-1 vs df2-2 | MEDIUM | AC5/DF2.2 Trigger | `share port`/`set-public` deferred DF2.2→DF4.1→DF4.2; nobody owns enforcement in between. | DF2.2 follow-up cell → DF4.2; DF4.1 AC5 grep test: neither verb shape appears in src/providers/. |
| ✅ | DF45-P1-21 | df4-2 | MEDIUM | Wiring closed | "Only this story + DF4.1 + DF2.2" false — e2e also needs DF1.4, DF2.3, DF1.6, DF2.5. | Rewrite wiring sentence naming all five predecessors; align edge line. |
| ✅ | DF45-P1-22 | df4-2 | LOW | Trigger row 5 | Full Vite build inside DF4.1-owned unit-test file — slow, non-hermetic, unowned. | `build:check` script in visualizer/package.json, run from CI typecheck step; Trigger cell → "CI step, not a test file". |

**DF4/DF5.5 verified-correct (do not regress):** DF5.5 amendment A occurrence table exact (every line number verified); amendment B NOT-FOUND claims all hold; DF4.1's read contract against DF1.4 genuinely pinned (archived column, readonly reader, cursor shape); package.json workspaces+lint claims real; DF4.2 bounded-scope arithmetic reconciles (modulo -12 labeling).

**DF5/DF6 verified-correct (do not regress):** all P0.11 chassis citations resolve (incl. preflight `:183,248,258`); all 29 phase-1 line citations resolve; DD-10 handled cleanly in DF5.2 (INV-PR-1 negative control mechanical); teardown-at-pause ordering consistent across DF3.4/DF5.2; DF2.1 pre-registers `pr`+`fixLoop` extension namespaces.

### Pass 1 — Cross-cutting (R-XC) — 17 findings: 1 B / 6 H / 8 M / 2 L

Dependency graph verified **acyclic**; no ghost IDs; df1-7 correctly absent (merged into DF1.1 per R5 §113). Point totals verified 31 stories / 111 pts. Extension namespaces, ref namespaces, gate evidence shape, exit-code partitions all consistent. p0-3 branch edit consistent with audit §5.

| Status | ID | File(s) | Sev | Finding | Fix recipe |
|--------|----|---------|-----|---------|------------|
| ✅ | XC-P1-01 | df3-6, df2-8 | BLOCKER | DF3.6 load-time ordering assertion reads *minted* `limitMicroUsd`; DF2.8 mints `min(default, remaining)` — every run near its issue cap is refused by DF3.6 after DF2.8 admitted it. | df3-6: split into config-time check on static defaults + per-run check with clamp-to-`limitMicroUsd` (journaled, never refused). df2-8 Tech Notes: name DF3.6 as consumer of minted cap. |
| ✅ | XC-P1-02 | df3-5,df3-1,df3-2,df3-4 | HIGH | `listVerbs()`/`src/fleet/verbs.ts` consumed by DF3.5, created by nobody (same root as DF3-P1-01). | DF3.1 Files+DoD own the registry; DF3.2/DF3.4 DoD register their verbs; DF3.5 cites DF3.1's DoD item. |
| ✅ | XC-P1-03 | epics(DF5.2), df3-4, df5-2 | HIGH | Index binds approval by `reportId`/`headSha`; DF3.4's closed schema lacks both; DF5.2 story binds temporally only. | Add required `reportId`+`headSha` to DF3.4 ApprovalRecord (written at requestApproval) + AC1 list; add match to DF5.2 AC1/AC3 verbatim from index. |
| ✅ | XC-P1-04 | df1-4, df1-6, df4-1 | HIGH | Prompt persistence has no schema owner; DF4.1 claims it exists (PR #97), DF1.6 authors it fresh, DF1.4 schema has no prompt event. | df1-4: add `prompt` event type with payload shape + round-trip DoD; df4-1: prompts come from `events` type `prompt` (DF1.4), drop PR #97 claim. |
| ✅ | XC-P1-05 | df1-4 (df4-1 unchanged) | HIGH | DF1.4 INV-3 says DF4.1 archives through tracer's connection; DF4.1 INV-4 says own second connection. DF4.1 architecturally right. | Amend df1-4 INV-3: DF4.1 opens own second connection scoped to `archived` (WAL second writer OK). |
| ✅ | XC-P1-06 | register — no story | HIGH | Per-box egress policy (D8/§6.3) orphaned — no story, no deferral record. | Register DD-11: deferred to OCI driver; §6.3 claim scoped to BYOK direct-provider egress for v5.0; scope caveat on DF3.5 factory-guide AC. |
| ✅ | XC-P1-07 | register — no story | MEDIUM | Permission fingerprinting (§3.3 ADOPT) appears in zero stories, no drop record. | Register DD-12: DEFERRED — superseded by one-run-one-box isolation (R8); re-enters if runs share a tree. |
| ✅ | XC-P1-08 | epics index | HIGH | DF5.5 sprint drift: index S2 vs story+yaml S3; index totals 47/45/19 vs real 47/43/21. **Decision: S3 wins** (deliberate PR #101 round-3 change); supersedes DF45-P1-05's direction. | Index: DF5.5 → v5-S3; header totals → 47/43/21 (pre-repoint; EPIC fixer recomputes after re-pointing). |
| ✅ | XC-P1-09 | epics index | MEDIUM | Index carries removed deps: DF1.8+P1.2, DF2.8+P1.2, DF5.2+P1.3/P1.7 — three S2 stories unstartable per index. | Index edges match story files, with removal parentheticals verbatim. (Same as DF1-P1-16/DF2-P1-14.) |
| ✅ | XC-P1-10 | df1-8, df3-1 | MEDIUM | Both own requestId resolution + pre-provision rejection, no edge — double implementation. | DF1.8 owns `resolveRunCorrelation`; DF3.1 calls it, owns exit-code mapping only; add DF1.8 to DF3.1 edges; mirrored boundary notes. |
| ✅ | XC-P1-11 | df5-5 | MEDIUM | Marker grep unscoped — returns 13, not 11 (story file + test contain the literal). | Scope grep to phase-0/phase-1 stories dirs (same as DF45-P1-15). |
| ✅ | XC-P1-12 | df5-5, epics | MEDIUM | Two different "11 KEEP files" sets (P0.5 dropped, P0.7 added). | Grep targets → p0-{5,7,9} (12 paths = 11 KEEP + P0.7); reword story + epics bullet (aligns w/ DF45-P1-06). |
| ✅ | XC-P1-13 | df1-6, df1-9, df2-7 | MEDIUM | Three S1 stories claim `runner.ts` (+types.ts/runner.test.ts) with contradictory cost semantics; merge order silently re-scopes assertions. | Add DF2.7 to df1-6 edges; delete df1-6 "until DF2.7 lands" deviation ("session-cumulative per DF2.7, lands first"); region-ownership note in all three. |
| ✅ | XC-P1-14 | df1-8, df3-3 | MEDIUM | Both S2 siblings edit `scripts/pipeline-run.ts`, no edge. | Mirrored shared-file notes; DF3.3 sequences after DF1.8. |
| ✅ | XC-P1-15 | epics index | MEDIUM | P1.18 3-pt carry-in hidden from index; S3 real load understated. | Index note: P1.18 carry-in, not in 31/111; add to index DF6.1 depends line. |
| ✅ | XC-P1-16 | epics index | LOW | DF1.6→DF1.8 numbering jump unexplained. | Footnote: DF1.7 merged into DF1.1 (R5 §1.5). |
| ✅ | XC-P1-17 | df5-4 | LOW | Clause map asserts against transitively-reachable artifacts not in dep line — readability gap. | Append transitive-deps parenthetical to dependency line. |

### Fix-wave-1 new findings (accepted)

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | DF1-P1-20 | df1-3 | MEDIUM | Fourth site of the stale "until DF2.7 lands" deviation (XC-P1-13 missed it); only DF1.2 declared as predecessor. | Add DF2.7 to df1-3 edges; delete deviation, state cost is session-cumulative per DF2.7. |
| ✅ | (resolved) | graph | LOW | Acyclicity re-check after new DF1.6←DF2.7 edge. | Verified by parent: DF2.7's only predecessor is P0.3 — no cycle. |
| ✅ | DF2-P1-24 | df2-4 | MEDIUM | df2-8 min() mint vs df2-4 direct --cap mint unreconciled. | df2-4 note: demo bypasses DF2.8's remainder computation by design; min() is the production path. |
| ✅ | DF2-P1-25 | df2-7 | LOW | Stale "bun 1.2.22" literal at :94. | "the project's bun toolchain", no version literal. |
| ✅ | DF2-P1-26 | df2-1 | HIGH | df3-2 AC9 writes `extensions.fanout` but allow-list had only `pr`/`fixLoop`. | Register `fanout` (DF3.2: fanoutId/arm) in df2-1 allow-list. |
| ✅ | DF3-P1-22 | df3-3 | MEDIUM | src/phase-engine/steering.ts shared by DF3.3/DF3.4 same sprint, note one-sided. | Mirrored note: DF3.3 authors the port; DF3.4 rebases, adds attach drain + ack only. |
| ✅ | DF45-P1-23 | df4-1 | LOW | models.ts vendored but unnamed in lib brace list. | Add `models` to the brace list. |
| ✅ | XC-P1-18 | df3-4 | HIGH | DF3-P1-10 recipe created DF3.4↔DF5.1 2-cycle. | Ruling: DF3.4 lands first (DF5.1 has the hard code dep on requestApproval); df3-4 drops DF5.1 edge, precondition via fixture ReverifyReport. |
| ✅ | (decision) | df6-1/epics | — | P1.18 dropped from DF6.1 predecessors (polling replaces webhook receiver). | XC-P1-15 resolution INVERTED: EPIC fixer removes P1.18's v5-S3 scheduling instead of documenting a carry-in. |
| ✅ | (watch) | df2-8/df5-4 | LOW | `qds cost` CLI verb may have lost its only consumer (C10 now uses readRunCost). | Resolved by XC-P2-14: intended operator billing surface, covered by df2-8's own e2e — no change. |

### Pass 2 — DF4 + DF5.5 (V2-DF45) — 11 findings: 0 B / 4 H / 4 M / 3 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF45-P2-01 | df5-5 | HIGH | Amendment E | **Wave-1 regression:** amendment E tightens the wrong pair — df2-3:116 chain is right-to-left, so the strict pair is budget-cap↔resident-ceiling (second `≥`), not key↔budget (which DF2.3's DoD requires non-strict). | Name pair by operand: amend to `run-key cap ≥ DF2.8 budget cap > DF3.6 per-run ceiling`, DF3.6 authority; key≥budget MUST stay non-strict; DoD byte-equivalence check vs df3-6:132 reversed. |
| ✅ | DF45-P2-02 | df5-5 | HIGH | Deps/AC4/Infra | DF1.8 written by amendment A (p1-9:25 P1.8→DF1.8) but absent from edges, AC4 set, and Infra row — defeats INV-4 for that edit. | Add DF1.8 to all three lists. |
| ✅ | DF45-P2-03 | df4-1 (+df2-2) | HIGH | AC5/DoD grep | Grep test "shapes appear nowhere under src/providers/" unsatisfiable — DF2.2's driver ships the six control-plane shapes incl. both, in S1. Also surfaces df2-2 internal contradiction (DoD :183 vs Trigger :86). | Rescope to behavioral: fake-driver argv spy asserts neither shape emitted for observe-started visualizer (pull DF4.2 INV-2 shape forward); textual grep scoped to call-construction module. Flag df2-2 contradiction to DF2 owner. |
| ✅ | DF45-P2-04 | df4-2 | HIGH | AC1/Infra/bunfig | Coverage floor inexpressible: global threshold can't scope two subtrees; deploy.ts pollutes aggregate; root bunfig leaks to future repo-wide --coverage runs. | `visualizer/bunfig.toml` + `cd visualizer && bun test --coverage`; floor = scoped aggregate; per-tree guarantee via lcov per-file assert. |
| ✅ | DF45-P2-05 | df4-2 | MEDIUM | AC6 | "DF2.5's ordering test passes unchanged" assumes prepend-tolerance DF2.5 never promises (ships 2 sprints earlier). | AC6 self-sufficient: relative-order/subsequence assert; extending an equality array is in DF4.2's scope; single-line DF2.5 amendment recording six-is-a-floor. |
| ✅ | DF45-P2-06 | df4-1 | MEDIUM | Infra "No DF2.9 edge" | Vendoring puts ~6 packages into the tree DF2.9's CI sweep fails-closed on; no DoD owns keeping the shipped gate green. | DoD: notice-sweep passes with visualizer workspace registered, NOTICE diff committed; replace "No DF2.9 edge" with consumer-gate wording. |
| ✅ | DF45-P2-07 | df4-1 | MEDIUM | AC1 CSRF | Both-headers-absent case undefined (every curl); reject breaks operator, allow reopens hole. | Decision table: Origin→check host; else Referer→check; both absent→allow only Bearer, 403 on Basic; DoD 4-combination test. |
| ✅ | DF45-P2-08 | df4-2 | MEDIUM | AC1 rationale | `.vue` files never enter bun coverage (no loader) — ignore-patterns inert, "App.vue under the floor" false; real gate is build:check. | Restate rationale; keep entries as future-proofing; drop the false sentence. |
| ✅ | DF45-P2-09 | df5-5 | LOW | Edge attribution | Edge list attributed to "A, C and E" but DF5.3 is written by amendment D. | Attribution → "A, C, D and E" in all three places (fold with -02). |
| ✅ | DF45-P2-10 | df4-1/df4-2 | LOW | Token wording | "Restart is rotation" (host token) collides with DF4.2's file-persisted per-box token. | Scope DF4.1's sentence to host-side; per-box token's rotation unit is the box. |
| ✅ | DF45-P2-11 | df5-5 | LOW | Overview ¶3 | "Ten of the 12" — inclusive-or union is eleven. | "Eleven of the 12" or split the counts. |

**V2-DF45 clean:** amendment-A table matches disk exactly; A–E each defined once; C anchors exist; E's location right (direction wrong); 8-route list pinned once; line arithmetic reconciles; startup/runtime split clean; token discipline consistent.

### Pass 2 — DF3 (V2-DF3) — 21 findings: 3 B / 4 H / 9 M / 5 L

| Status | ID | Story | Sev | Section | Finding | Fix recipe |
|--------|----|-------|-----|---------|---------|------------|
| ✅ | DF3-P2-01 | df3-2+df3-4 | BLOCKER | arm completion/attach ack | `driver.observe(vm)` called as driver method; DF2.1's port has no `observe` — it's a host-side verb composing exec/copyFile. | Replace with `driver.exec`/`copyFile` in DF3.2 AC5+Infra and DF3.4 transport note+Infra, or name a host-side `observe(vm)` helper's owner/module/signature once and cite it. |
| ✅ | DF3-P2-02 | df3-2 (+df1-1) | BLOCKER | AC5/Infra | `/run/journal/final.json` marker has no producer (DF1.1 writes only to `--journal <path>`); predicate keys on nonexistent run-level `exitStatus`. | DF1.1 AC: `finish(accepted)` also writes `/run/journal/final.json` `{runId, ok, completedAt}`; DF3.2 predicate on `ok === true`. |
| ✅ | DF3-P2-03 | df3-2 | HIGH | AC5 | All-arms-fail race hangs — non-success marker is neither win nor armUnknown. | AC5: non-success marker → `armFailed`; all-fail → exit non-zero, teardown all via DF2.5, `winner: null`. |
| ✅ | DF3-P2-04 | df3-2 (+df3-1) | HIGH | AC7 | `uniqueFileCoverage` needs `briefTargetFiles` — not in DF3.1's closed brief schema; degenerates every score to 0.6×testPassRate. | Add `targetFiles: string[]` to DF3.1 brief schema + cite from AC7, or revert to P1.4's cross-arm union denominator. |
| ✅ | DF3-P2-05 | df3-2 | MEDIUM | AC7 | "Renormalized" false: 0.5/0.3 renormalizes to 0.625/0.375, not 0.6/0.4; DoD asserts 6dp. | Keep 0.6/0.4, say "re-weighted"; align DoD fixture. |
| ✅ | DF3-P2-06 | df3-2 | MEDIUM | AC9/DoD | `extensions.fanout` omits `schemaVersion` required by DF2.1 of every namespace. | Write `{schemaVersion: 1, fanoutId, arm}`. |
| ✅ | DF3-P2-07 | df3-4 | BLOCKER | E2E vs AC1/INV-APPROVE-6 | **Wave-1 regression:** E2E orders record-write → teardown; AC1/INV/Infra order teardown → record. | Rewrite E2E arrow to match AC1 (teardown first, then awaiting-approval record). |
| ✅ | DF3-P2-08 | df3-4 (+df5-1) | HIGH | AC1/Overview | `requestApproval(runId, proposal)` 2-arg signature can't supply now-required `reportId`/`headSha`. | Signature → `requestApproval(runId, proposal, report)` (or single object) in DF3.4 ×4 sites and DF5.1 AC6+DoD. |
| ✅ | DF3-P2-09 | df3-4 (+df5-2) | MEDIUM | Contracts | `reportId` source field unnamed (DF5.1's identity is `reverifyId`). | `ApprovalRecord.reportId := ReverifyReport.reverifyId`; mirror in DF5.2 Infra row. |
| ✅ | DF3-P2-10 | df3-4 | MEDIUM | Trigger/DoD/Files | Paused-runs `fleet status` + expiry sweep has no file (`src/fleet/status.ts` absent) and no join owner. | Add status.ts to Files ("adds only" note); name `.sandbox/approvals/` as third status source in an AC. |
| ✅ | DF3-P2-11 | df3-4 | MEDIUM | AC1 failure mode | Crash between teardown and record write = destroyed box, revoked key, no record. | Intent record `O_EXCL` at awaiting-approval BEFORE destroy, updated after; or fail-closed logged write that blocks PR path. |
| ✅ | DF3-P2-12 | df3-4 | LOW | AC3 | "auto-ABORTs" undefined post-teardown. | Record closes `timed-out`, terminal like `rejected`, no PR path. |
| ✅ | DF3-P2-13 | df3-6 (+df3-3, df1-5) | HIGH | pre-flight projection | Rate source doesn't exist: DF1.5 roster schema closed, no `cost` key; models.json keys differ. | DF1.5 exports `resolveRate(slug)` from the models.json it validates + DoD; no-rate ⇒ resident not started; DF3.6/DF3.3 use DF1.5 key names. |
| ✅ | DF3-P2-14 | df3-6 (+df3-3) | MEDIUM | AC4 | "resident record carries exitStatus:overflow" — artifact undefined. | Journal `resident.exitStatus`, added to DF3.3 AC5's journal list; or carry in watchdog_kill detail. |
| ✅ | DF3-P2-15 | df3-6 | MEDIUM | AC2a/DoD | "exits bound-config-invalid" mixes error code with exit code. | Non-zero numeric exit + `{code:"bound-config-invalid"}` in payload (house rule DF3.1 AC3). |
| ✅ | DF3-P2-16 | df3-3/df3-4/df3-6 | MEDIUM | Files | Three S2 stories edit steering.ts; DF3.6 has no ordering note. | Three-way order: DF3.3 authors → DF3.4 drain/ack → DF3.6 checkBounds guard; "adds only" each. |
| ✅ | DF3-P2-17 | epics doc ~510 | MEDIUM | epic bullets | Epic still states minted-cap ordering the story now marks MUST-FAIL; DF3.2/DF3.4 bullets predate AC8/AC9/reportId. | Sync bullets or stamp epic "summary, non-normative; story files govern". |
| ✅ | DF3-P2-18 | df3-5 | MEDIUM | Deps/Infra | DF3.2 is the named sprint-compression cut but DF3.5 hard-depends on it. | One line: if DF3.2 unmerged, factory-dispatch documents dispatch only; AC1 enforces. |
| ✅ | DF3-P2-19 | df3-1/df3-2 | LOW | exit table | Exit `5` defined as admission refusal; AC8 also uses it for lock busy. | Widen row: "`5` fan-out refused before provisioning — admission or lock (payload code distinguishes)". |
| ✅ | DF3-P2-20 | df3-4 | LOW | pause teardown | Re-harvests by default; bundle already harvested pre-re-verify. | `teardown(runId, {noHarvest: true})`. |
| ✅ | DF3-P2-21 | df3-3 | LOW | E2E | `directives:[3]` reads as array-of-3. | `directives: 3` (count). |

**V2-DF3 clean:** DF3.1 no story-local defects; DF3.3 strongest in epic (two-shape AC1 proof genuinely testable).

### Pass 2 — DF1 (V2-DF1) — 16 findings: 0 B / 3 H / 8 M / 5 L

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | DF1-P2-01 | df1-1 (+df1-3) | HIGH | Circular ownership: DF1.1's formula/test/schema attribute `PARSE_FIX_ATTEMPTS` and `retries 0..5` bound to DF1.3, which lands later. | Move both constants into DF1.1 (`src/phase-engine/types.ts`); DF1.3 references them. |
| ✅ | DF1-P2-02 | df1-1 | MEDIUM | Mandatory e2e refuses load at default `maxDurationMs` 600k (needs ≥3.61M ms vs --budget-ms 120k). | Fixture pins `maxDurationMs: 15000`/phase (=100k ≤ 120k). |
| ✅ | DF1-P2-03 | df1-1 | MEDIUM | Walk termination undefined for thrown body (only overflow path stated). | AC: thrown body halts walk; remaining phases not constructed, no journal rows; mirror in Run.finish. |
| ✅ | DF1-P2-04 | df1-2 | MEDIUM | E2E asserts 4 checks/1 violation from a single `commandGate` that produces exactly 1 check. | Name the 4-gate set in the slice + aggregate-into-one-report rule, or reduce assert to 1/1. |
| ✅ | DF1-P2-05 | df1-2 | MEDIUM | `QualityCheckResult.spawnEnv` (holds provider key) has no no-persist invariant. | INV-6: spawnEnv redaction-input only, never journaled/traced/serialized; sentinel negative-control DoD test. |
| ✅ | DF1-P2-06 | df1-2 | LOW | Infra pi-lens row conflates non-zero exit with spawn error (AC5). | Reword: unspawnable binary → failed check, never pass/skip. |
| ✅ | DF1-P2-07 | df1-3 | HIGH | `(agent, model)` session key has no source — roster attributed to DF1.1 which owns none; DF1.5 not a dep. | (b) chosen shape: declare `PhaseParams.agent {agentId, provider, model, contextWindow}` owned by DF1.1 (add to DF1.1 contract+schema); DF1.3 cites that field. |
| ✅ | DF1-P2-08 | df1-8 | LOW | Stale amendment text — DF1.4's INV-5 already additive; wave-1 leftover. | "Issues its index through DF1.4's existing SCHEMA_INDEX_DDL"; drop amendment mention. |
| ✅ | DF1-P2-09 | df1-5 | MEDIUM | DoD forces both gates `unverified` when only catalog gate is. | DoD: catalog gate unverified, provider gate keeps real verdict, exit 2 (INV-4). |
| ✅ | DF1-P2-10 | df1-6 | HIGH | RSS watchdog called "RE-AIMED" but doesn't exist (net-new, no AC, outside declared region); `killTree` is SIGKILL-only, can't do stated SIGTERM→SIGKILL. | Promote watchdog to numbered AC (interval/threshold/tree/overflow); extend region note; escalation = SIGTERM to group → WATCHDOG_GRACE_MS (runner.ts:77) → killTree. |
| ✅ | DF1-P2-11 | df1-6 | MEDIUM | Oversize (>1MiB) lines dropped pre-parser, counted by nothing. | Add `droppedOversizeLines` counter; AC2 scoped to surviving lines; Observability Contract. |
| ✅ | DF1-P2-12 | df1-6 (+df1-1) | MEDIUM | AC6 "host-side" misuses the v5 term of art (engine is in-box); reads as discharging DF5.1. | "Engine-side (in-box, outside the team process)"; note it does NOT satisfy DF5.1's out-of-box re-verification. |
| ✅ | DF1-P2-13 | df1-6 | MEDIUM | Roster-adapter negative control unfailable (first-slash split is the correct behavior). | Reword: last-`/` split or `.split("/")[0]/[1]` MUST fail. |
| ✅ | DF1-P2-14 | df1-6 | LOW | Nobody named as setter of `QDS_TEAM_RUNNER=local` in-box. | Infra row: set by box setup (DF2.2)/fleet dispatch (DF3.1); absent → AC5 refusal. |
| ✅ | DF1-P2-15 | df1-9+df1-6 | LOW | types.ts also shared, ownership note covers runner.ts only. | Extend note: DF1.9 owns TeamRoleSchema (:33-49), DF1.6 owns merged-output surface (:125-145). |
| ✅ | DF1-P2-16 | epics+register | MEDIUM | Register §2 still 111 pts/47/19; index DF1.2 bullet preserves the pre-fix `passed` formula. | Update register §2 + compression math + re-baseline DD note; sync DF1.2 bullet to `checks.length>0 &&` formula. |

**V2-DF1 clean:** no fabricated citations; df1-4, df1-8, df1-9 clean on own merits (minor items only).

### Pass 2 — DF5+DF6 (V2-DF56) — 13 findings: 0 B / 5 H / 4 M / 4 L

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | DF56-P2-01 | df5-1 (+df3-4) | HIGH | 2-arg `requestApproval(runId, proposal)` can't carry now-required reportId/headSha; reverifyId↔reportId never equated. (= DF3-P2-08/-09) | Signature → `requestApproval(runId, {proposal, reportId, headSha})` everywhere; Tech Note `reportId := reverifyId`, `headSha` from report. |
| ✅ | DF56-P2-02 | df5-1+df3-4 | HIGH | Re-run reverify after approval bricks the run: O_EXCL blocks second request; DF5.2 reads latest report vs approval bound to old — permanent refusal. | DF5.1 AC6: existing awaiting-approval record rebound atomically to new reportId; terminal record → flag, no request. DF3.4 AC1 reciprocal: O_EXCL first-create only; rebind on undecided, refusal returning decision on terminal. |
| ✅ | DF56-P2-03 | df6-1 | HIGH | 15-min attempt ceiling spans re-verify (30-min cap) + human approval (24h) — every fix run aborts at approval gate. | Split budget: 15-min = CI-poll window from pushVerifiedSha return; execution inherits DF3.1/DF5.1 caps; approval wait excluded, timeout → `approval-timed-out`. |
| ✅ | DF56-P2-04 | df6-1 | HIGH | `botComments[]` doesn't fit DF3.1's closed brief schema (file not owned); AC5's write-access guard has no source (DF1.5 `writes` not a dep). | Own brief-schema.ts registration of allow-listed `fixContext` key; AC5 reads DF1.5 per-role `writes` (write-capable ⟺ writes !== []), rejects pre-dispatch; add DF1.5 dep. |
| ✅ | DF56-P2-05 | df6-1 (+df5-3) | HIGH | Audit chain can't reconstruct fix loop: fix run's chain reached by no hop; INV-AUDIT-6 violated (partial reported complete). | DF6.1: add DF5.3 dep; AC emitting recordAuditLink rows per attempt + extensions.fixLoop.runIds; walkAuditChain resolves hops per contributing runId, missing fix-run chain = broken hop; add src/audit/chain.ts to Files. |
| ✅ | DF56-P2-06 | df5-2 | MEDIUM | Refusal path's only sink is issue comment; issue-less runs make fail-closed AC3 unsatisfiable. | Durable host-side refusal record; issue comment best-effort; DoD issue-less red-report test. |
| ✅ | DF56-P2-07 | df5-2 (+epics) | MEDIUM | E2E body `Closes #42` fails DF5.4-C8's required `Issue:` label. | `Issue: Closes #42`; align cost-line casing; fix epics §DF5.2 line. |
| ✅ | DF56-P2-08 | df5-1+df5-2 | MEDIUM | `redactSecrets(text, parentEnv)` redacts only env-present values; both stories require those secrets absent from env — redaction is structural no-op, sentinel tests vacuous. | Pass purpose-built map of known-sensitive values (never process.env); sentinel planted in gate output/body input so env-only impl fails. |
| ✅ | DF56-P2-09 | df6-1 | MEDIUM | "Host validates diff before execution" impossible — host first sees diff at harvest. | Validate harvested diff at re-verify/push; out-of-scope path blocks pushVerifiedSha; in-box scoping advisory. |
| ✅ | DF56-P2-10 | df5-3 | LOW | DoD restates UNIQUE without the COALESCE generated column — reintroduces NULL-dup bug. | Quote generated-column form verbatim. |
| ✅ | DF56-P2-11 | df5-4 | LOW | Evidence-path list omits `.sandbox/reverify/<run-id>.jsonl`. | Add path; optionally C7 asserts decidedAt > completedAt. |
| ✅ | DF56-P2-12 | df6-1 | LOW | `attemptSha` via local rev-parse racy. | attemptSha = the sha pushVerifiedSha pushed (= report headSha). |
| ✅ | DF56-P2-13 | df5-2 | LOW | DF2.1 registry line stale (pr sub-key now 3 fields incl. createdAt). | One-line note in DF5.2 TN (registry illustrative) or DF5.5 amendment. |

**V2-DF56 clean:** all anchors resolve; DF3.4↔DF5.1 direction correct both sides; PR-author identity model correct; df5-4 essentially clean.

### Pass 2 — Cross-cutting (V2-XC) — 14 findings: 0 B / 1 H / 6 M / 7 L/INFO

Graph acyclic, totals reconcile exactly (123/53/45/25 across all three sources), no consumer-before-producer. S2 critical path: DF1.8→DF3.1→DF3.3→DF3.4→DF5.1→DF5.2 (six deep).

| Status | ID | File(s) | Sev | Finding | Fix recipe |
|--------|----|---------|-----|---------|------------|
| ✅ | XC-P2-01 | df4-1 vs df2-2 | HIGH | AC5 grep can never pass — DF2.2 legitimately ships both shapes in S1. (= DF45-P2-03) | Re-scope grep: no call site passes resolved QDS_VIZ_PORT to expose/setPublic without assertNeverPublic. |
| ✅ | XC-P2-02 | df3-2 vs df1-6 | MEDIUM | Rank formula divides by boolean `testsExecuted`, names nonexistent `testsPassed`. | `testPassRate = testsExecuted ? passed/(passed+failed) : 0` with guard. (briefTargetFiles → DF3-P2-04.) |
| ✅ | XC-P2-03 | df3-2 vs df1-1 | MEDIUM | Completion marker has no producer. (= DF3-P2-02; fix in DF1.1.) | DF1.1 `finish(accepted)` writes fixed marker `{ok,...}`; DF3.2 predicate on `ok === true`. |
| ✅ | XC-P2-04 | df3-6 vs df1-5 | MEDIUM | Bundled-catalog slugs have no DF1.5-validated rate; projection inputless. (= DF3-P2-13.) | DF1.5 AC: every resolved role carries (input, output) rate from catalog or models.json; reject if neither. |
| ✅ | XC-P2-05 | df3-3/4/6 | MEDIUM | steering.ts three-way ordering missing DF3.6 leg. (= DF3-P2-16.) | Three-way order note mirrored in all three. |
| ✅ | XC-P2-06 | df1-6/df1-9/df2-7 | MEDIUM | types.ts regions unowned (runner.ts note doesn't cover it); also src/phase-engine/types.ts (DF1.3+DF1.4). | Extend notes naming types.ts regions per owner. (⊃ DF1-P2-15.) |
| ✅ | XC-P2-07 | register §2 | MEDIUM | Register still 111 pts + stale compression math. (= DF1-P2-16 register half.) | Update §2, re-derive compression (123−10−4−6=103), re-baseline note. |
| ✅ | XC-P2-08 | df5-5 | LOW-MED | DF1.8 written by amendment A but absent from edges/Infra/AC4; "A, C and E" should be "A, C, D and E". (= DF45-P2-02/-09.) | Add DF1.8 all three places; fix attribution both places. |
| ✅ | XC-P2-08b | df5-5 | LOW | INV-1 worded KEEP-only while amendment E edits a DF file. | Widen INV-1 to "any file this chore edits". |
| ✅ | XC-P2-09 | df2-1 | LOW | DoD says "both pr and fixLoop registered" — under-delivers fanout by one. | DoD → "pr, fixLoop and fanout". |
| ✅ | XC-P2-10 | df5-1 | LOW | ExitStatus cite `:84` wrong; declaration at `:79`. | `:84` → `:79`. |
| ✅ | XC-P2-11 | df4-1 vs df2-9 | LOW | NOTICE-sweep obligation on vendored tree unowned. (= DF45-P2-06.) | DF4.1 DoD: run sweep post-vendoring, commit NOTICE diff. |
| ✅ | XC-P2-12 | df1-6 vs df1-4 | LOW | "Every prompt persisted pre-execution" unenforced in DF1.6 (Observability-only). | DF1.6 DoD: prompt event per role written pre-spawn, read back for a mid-phase-killed run. |
| ✅ | XC-P2-13 | df2-4 vs df3-6 | LOW | DF2.4 chain names minted `runKeyCapMicros` in the load assertion DF3.6 forbids. | Spell third term `defaultKeyCapMicroUsd`; minted cap only clamps (AC2b). |
| ✅ | XC-P2-14 | df2-8 | INFO | `qds cost` has no in-slate consumer but is the operator billing surface, covered by own e2e. Parent: intended — no change. | — |

**V2-XC clean:** watch items (b) amendment-set coherence and (c) §5.2 invariant ownership both confirmed (modulo XC-P2-12).

### Pass 2 — DF2 (V2-DF2) — 15 findings: 1 B / 5 H / 7 M / 2 L

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | DF2-P2-01 | df2-7 (+df2-8, df1-3) | BLOCKER | "Session-cumulative" undefined across resumed sessions — same `--session-id` reuse may double-count in ledger SUM and phase accumulator; probe runs `--no-session` so can't settle it. | Probe leg: two invocations same session-id, record reset boundary; state boundary in DF2.7; AC: same-session rows SUM to true total + double-counting negative control. |
| ✅ | DF2-P2-02 | df2-8 (+df3-1) | HIGH | Pre-spawn budget gate has no production caller — df3-1 never calls it, no edge. | df3-1 AC: dispatch calls `assertWithinBudget(brief.repoSlug, brief.issueRef)` pre-create, over-cap = refusal payload + zero provisioning; DF2.8→DF3.1 edge. |
| ✅ | DF2-P2-03 | df2-8 (+df2-5) | HIGH | Nobody writes box_hours row (DF2.5 not a dep, teardown.ts not in Files, six-step order has no ledger step); df5-3 asserts on it. | Add DF2.5 edge + teardown.ts; AC hooking close step to ingestBoxHours; aborted teardown writes no row; mirror line in df2-5 boundary list. |
| ✅ | DF2-P2-04 | df2-4 | HIGH | `providerCapRejected`/`terminationProvenance` have no producer; in-box observation violates own trust boundary. | Host re-probes provider with retained key post-termination; provenance set host-side by which guard fired; AC: re-probe (not box) sets both. |
| ✅ | DF2-P2-05 | epics §DF2.3 | HIGH | Epic bullet still says record CLOSED with snake_case fields. | Replace with story text (left open, camelCase; closure = DF2.5); sweep epic for snake_case record fields. |
| ✅ | DF2-P2-06 | df2-1,df2-9,register | HIGH | Register §2 stale (111 pts); S1 at 53 over capacity; df2-9 header self-contradicts ("v5-S1 … absorb v5-S2 slack"). | Register update + decision: DF2.9 → v5-S2 (S1 48 · S2 50 · S3 25 = 123); fix df2-9 header. |
| ✅ | DF2-P2-07 | df2-6 | MEDIUM | Key↔record join key unstated; two ACs need different ones; paired-pending unreachable under name-join. | Join once by derived runId (strip sbx-); keyHash confirms; AC7 recast: no record file at all + young creation time; test withholds record. |
| ✅ | DF2-P2-08 | df2-3 | MEDIUM | Strictness contradicts DF3.6/DF2.4 (non-strict ≥ vs strict <); three stories claim the load assertion. | Copy DF3.6's strict chain verbatim; DF3.6's manifest loader is single owner; DF2.3/DF2.8 reference. |
| ✅ | DF2-P2-09 | df2-1 | MEDIUM | DoD registers only pr+fixLoop; fanout omitted. (= XC-P2-09) | "pr, fixLoop and fanout"; allow-list test adds accepted fanout write. |
| ✅ | DF2-P2-10 | df2-6 (+df3-1) | MEDIUM | Serial single dispatches bypass headroom ceiling (F9); DF2.6 AC2 has no owner. | df3-1 AC: dispatch calls checkHeadroom(1) pre-create; DF2.6→DF3.1 edge; boundary note re-worded. |
| ✅ | DF2-P2-11 | df2-4 | MEDIUM | classifyRunExit "every run" claim unimplementable (no execute-path file in scope). | Narrow trigger row to demo path + Follow-Up to DF3.1/DF1.6 for production wiring. |
| ✅ | DF2-P2-12 | df2-8 | MEDIUM | issue_id NOT NULL vs DoD's "run with no issue reference" readRunCost rationale — empty ledger indistinguishable from no-spend. | Keep NOT NULL; re-word DoD ("run-keyed view read without needing the issue ref"). |
| ✅ | DF2-P2-13 | df2-7 (+df1-6) | MEDIUM | Tier-3 harness cap ($0.45 default kill) sits inside all asserted ceilings, unvalidated — every run dies at $0.45 vs advertised $5. | df2-7: harness cap raised at spawn to run's effective ceiling, owner DF1.6; df1-6 spawn-seam note + DoD line sets `budgetCapUsd = effectiveCeiling`. |
| ✅ | DF2-P2-14 | df2-6 | LOW | `staleAfterMs` no default; harvest-abort loop re-reaps forever. | Default 14_400_000 ms; after K failed reaps → `reap-blocked` report + stop retrying. |
| ✅ | DF2-P2-15 | epics §DF2.2 | LOW | Epic bullet says process exits assertion code; story returns payload. | Re-word to returns-shape; scripts-level maps exit. |

**V2-DF2 clean:** every citation resolves; df2-5, df2-9 clean on own merits.

### Pass 3 — DF1+DF2 (V3-A) — 9 findings: 0 B / 3 H / 3 M / 3 L

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | A-P3-01 | df1-5 (+df3-3, df3-6) | HIGH | `resolveRate` integer µ$/token rounds cheap models to 0 — ceiling never fires; DoD self-contradictory. | Unit → integer µ$ per **million** tokens (`inputPerMTok`, ...); consumers divide by 1e6 at projection; update df1-5 AC6 + tests + df3-6:122/:162, df3-3:115/:159. |
| ✅ | A-P3-02 | df1-6 (+df2-2) | HIGH | `QDS_TEAM_RUNNER=local` producer named (DF2.2/DF3.1) but neither story's ACs own it — every run refuses at first dispatch_task. | DF2.2 `setup` writes it into box run env (beside .env key-delivery contract) via AC/DoD line; df1-6 Infra cites that AC. |
| ✅ | A-P3-03 | df1-2 | HIGH | Mandatory e2e impossible: gate throws on same phase, walk halts (df1-1 AC6), so no "next phase's previous: slot" exists. | Two-phase slice: failing code phase (no gate) → envelope flows via previous:; gate on phase 2 which reads fail and ends walk. |
| ✅ | A-P3-04 | df1-1 (+df3-2) | MEDIUM | `/run/journal/final.json` unwritable in host tests (root-owned Linux, absent darwin). | `RUN_MARKER_ROOT = QDS_RUN_ROOT ?? "/run"`, host-test-only override; mirror sentence into df3-2 Infra row. |
| ✅ | A-P3-05 | df1-2 (+df1-3, df1-4) | MEDIUM | `PhaseParams.previous` edit has no declared file; region notes say "three stories" omitting DF1.2. | Add phase-engine types.ts to df1-2 Files ("adds only previous"); region paragraphs → four stories. |
| ✅ | A-P3-06 | df1-3 | MEDIUM | Infra rows still say "DF1.1 roster validation" — wave-2 leftover contradicting own Tech Notes. | Reword both hooks to `PhaseParams.agent` populated by phase constructor; absent ⇒ no cached session. |
| ✅ | A-P3-07 | df1-1 | LOW | `effectiveCeilingMicros` Tech-Notes-only in owner story. | Append to Contract DoD (optional field, absent ≠ zero ≠ unlimited). |
| ✅ | A-P3-08 | df1-1,1-4,1-6,1-8 | LOW | Stale "bun 1.2.22" ×5 sites. | "The project's bun toolchain" everywhere. |
| ✅ | A-P3-09 | df2-4 | LOW | AC2 merge residue: doubled negative-control lines + dangling fragment. | Fold fragment; keep one negative-control line. |

**V3-A clean verdicts:** final.json marker, PhaseParams.agent, retry constants, watchdog AC7 (WATCHDOG_GRACE_MS=5000 verified), session-cumulative boundary, ingestBoxHours, ceiling single-owner, reaper, host re-probe, extensions registry, df2-9 sprint — all CLEAN. resolveRate single-ownership correct; only the unit defective.

### Pass 3 — DF3–DF6 (V3-B) — 8 findings: 1 B / 2 H / 2 M / 3 L

| Status | ID | Story | Sev | Finding | Fix recipe |
|--------|----|-------|-----|---------|------------|
| ✅ | B-P3-01 | df3-4 (+df5-1) | BLOCKER | Rebind decision landed one side only — df3-4's O_EXCL + "written at requestApproval time" still bricks second request; no rebind-vs-decision race rule. | df3-4 AC1: O_EXCL first-create only; rebind by atomic replace under file lock, `supersededReportIds[]` field; terminal → no write, returns decision; submitDecision compare-and-sets on the reportId it read; mirror df5-1's DoD test. |
| ✅ | B-P3-02 | df5-1 | MEDIUM | Rebind trichotomy misses `pausing` (non-terminal, not awaiting-approval). | AC6: pausing → not rebound, `flags:["approval-pause-in-progress"]`; df3-4 resume path clears. |
| ✅ | B-P3-03 | df3-6 (+df3-1) | HIGH | AC2b clamp reads host-side `.sandbox/runs/<id>.json` from inside the box — nothing carries `limitMicroUsd` across the boundary; INV-BND-2 fail-closed ⇒ every run refuses. | DF3.1 dispatch stamps minted `limitMicroUsd` into the frozen manifest at fill; engine reads only from there (INV-BND-1-safe); Infra row + df3-1 writer line + refuse-if-absent DoD test. |
| ✅ | B-P3-04 | df5-5 (+df3-6) | HIGH | Amendment E stale — wave 2 already put the verbatim strict chain in df2-3; chore halts on missing target or rewrites a correct copy. | Retire E as NOT-FOUND/already-satisfied (amendment-B pattern); DF3.6 drops from df5-5 edges/AC4; df3-6 reconciliation paragraph rewritten to current state. |
| ✅ | B-P3-05 | df6-1 (+df5-3) | MEDIUM | `extensions.fixLoop` record ambiguity (PR has no extensions; fixContext per-attempt vs fixOutcome on parent); df5-3 pinned to "ten hops" for one run. | df6-1: fixContext on fix run's record, fixOutcome (runIds) on parent's record via hop 1; df5-3: chain object keyed by contributing runId (default single entry, extended by DF6.1); DoD "ten hops per contributing runId". |
| ✅ | B-P3-06 | df5-4, df5-3 | LOW | `decided_at` snake_case drift. | `decidedAt`. |
| ✅ | B-P3-07 | df3-3, df3-6 | LOW | resolveRate typed 2-key; DF1.5 returns 4-key. | Four-key return + "reads input/output only". |
| ✅ | B-P3-08 | df5-5 | LOW | DoD cites df3-6:132; drifted to :136. | Cite by text, not line number. |

**V3-B clean:** pausing-first flow, requestApproval signature (byte-identical everywhere), dispatch admission, fanout, steering three-way, df6-1 budget/injection/attemptSha, df5-2, df5-3 UNIQUE, df5-4 clauses, df4 split, df5-5 counts, no TODO/FIXME.

### Pass 3 — Cross-cutting (V3-XC) — 10 findings: 0 B / 1 H / 5 M / 4 L

Graph acyclic (13 topological levels), edges byte-consistent across all three artifacts, totals exact (123, 48/50/25).

| Status | ID | File(s) | Sev | Finding | Fix recipe |
|--------|----|---------|-----|---------|------------|
| ✅ | XC-P3-01 | df1-1,df1-4,df1-8 | MEDIUM | phase-engine types.ts is 4-way, described 3-way; DF1.8 region undeclared. | Add DF1.8 to df1-1 parenthetical; "Four stories"; df1-8 "adds only issue-correlation types". |
| ✅ | XC-P3-02 | df3-2,df3-4 | MEDIUM | Both register verbs in verbs.ts but neither lists the file. | Add `src/fleet/verbs.ts` (adds-only own entries) to both Files lists. |
| ✅ | XC-P3-03 | df3-1,df2-8 (+df1-1) | HIGH | `effectiveCeilingMicros` has consumer (DF1.6 spawn raise) and no producer — every run spawns at $0.50 default. | DF3.1 AC+DoD: dispatch sets run-context field = min(remainingMicroUsd, defaultKeyCapMicroUsd) (same value handed to mint) pre-tier-2; DF2.8 boundary line names assertWithinBudget's return as the propagated value. |
| ✅ | XC-P3-04 | df5-3 | MEDIUM | chain.ts claim one-directional (df6-1 says adds-only; df5-3 silent, pinned to ten hops). | Mirror note in df5-3 TN (additive, no signature change, DF6.1 lands after). |
| ✅ | XC-P3-05 | df3-1 | MEDIUM | Closed brief schema vs df6-1's fixContext registration read as contradictory. | df3-1 TN: closed to callers (ingress rejection); later stories may add a top-level key to the schema file; DF6.1 does so. |
| ✅ | XC-P3-06 | df3-5 | MEDIUM | DD-11 egress scope caveat assigned to DF3.5, never encoded. | AC/TN: factory-guide states v5.0 containment scope (BYOK direct-provider only, no per-VM allowlist, re-enters with OCI driver), cites DD-11; add as sixth lint pattern. |
| ✅ | XC-P3-07 | df2-5 | LOW | Teardown note omits `ingestBoxHours` symbol + DF5.3 as fourth claimant. | Name function; add DF5.3's recordAuditLink emit with merge order. |
| ✅ | XC-P3-08 | epics | LOW | Title drift on DF3.3/DF3.6 headings vs yaml/story. | Story H1 is authority; align epics headings. |
| ✅ | XC-P3-09 | df1-1 | LOW | PhaseParams.agent "populated by DF1.5's roster resolution" — df1-5 silent. | Soften df1-1 to "the run's roster resolution, where one is configured". |
| ✅ | XC-P3-10 | df3-2 | LOW | DF2.6 same-sprint direct call, no ordering note (transitively safe). | One sentence mirroring df3-1's sequencing note. |

## Parent decisions — Pass 3 (final fix wave)

- **B-P3-03 + XC-P3-03 together (df3-1 is the linchpin):** DF3.1 dispatch (a) stamps minted `limitMicroUsd` into the frozen manifest at fill, (b) sets run-context `effectiveCeilingMicros = min(remainingMicroUsd, defaultKeyCapMicroUsd)`; DF2.8 boundary line names the value; df3-6 reads the cap only from the manifest.
- **B-P3-04:** amendment E retired as already-satisfied; DF3.6 drops from df5-5's edges/AC4; epics/yaml re-synced.
- **A-P3-01:** resolveRate unit = integer µ$ per million tokens.
- **A-P3-02:** DF2.2 owns writing `QDS_TEAM_RUNNER=local` into the box run env.
- **XC-P3-09:** soften df1-1 (single-file fix).

## Parent decisions — Pass 2 (fix wave 2)

- **DF3-P2-04:** revert `uniqueFileCoverage` denominator to P1.4's cross-arm union — no new brief field. (XC-P2-02's testPassRate fix still applies.)
- **DF3-P2-07 + -11 together:** intent-record-first ordering (evidence-first doctrine): ApprovalRecord created `O_EXCL` in state `pausing` BEFORE teardown, promoted to `awaiting-approval` after teardown completes; AC1, E2E, INV-APPROVE-6 rewritten coherently; crash window leaves a `pausing` record with bundle path.
- **requestApproval signature:** `requestApproval(runId, {proposal, reportId, headSha})`; `reportId := ReverifyReport.reverifyId`.
- **DF56-P2-02:** rebind-on-undecided / refuse-with-decision-on-terminal, per recipe, both sides.
- **DF2-P2-06:** DF2.9 moves to v5-S2 → sprints 48/50/25 = 123.
- **DF2-P2-13:** DF1.6 owns raising harness cap at spawn.
- **DF45-P2-03 + XC-P2-01 merged:** behavioral spy (no shape emitted for observe-started visualizer) + port-scoped grep (no call site passes QDS_VIZ_PORT to expose/setPublic outside assertNeverPublic).
- **DF45-P2-05:** df2-5 gains one line: six-step order is a floor (relative-order contract), prepend-tolerant tests.
- **DF56-P2-04:** DF6.1 registers allow-listed `fixContext` brief key (owns brief-schema.ts edit, "adds only"); AC5 reads DF1.5 `writes`; DF1.5 edge added.
- **XC-P2-14:** `qds cost` intended as operator billing surface — no change.

## Parent decisions (conflicts resolved)

- **XC-P1-08 vs DF45-P1-05:** DF5.5 stays **v5-S3** (deliberate round-3 change); epics index aligns to story, not vice versa. DF45-P1-05's edge-trim portion (DF45-P1-17) still applies.
- **XC-P1-01 canonical** for the ordering-assertion defect; DF2-P1-02's config-load-only clause folds into it.
- **DF56-P1-03:** approval-per-fix-attempt (keep INV-PR-5 intact), not a carve-out.
- **DF3-P1-10(c):** DF5.1 gets the `requestApproval` caller AC (single owner); df3-4 notes caller is DF5.1.
- **Re-pointing accepted:** df1-6 5→8, df2-1 3→4, df2-9 3→5, df3-4 4→6, df4-1 4→6, df6-1 4→6. New totals: DF1 32, DF2 34, DF3 24, DF4 10, DF5 17, DF6 6 = **123 pts / 31 stories**. No story splits (fewest files).
- **DF3-P1-18 mirror:** DF2 fixer adds the closed-record-extensions-writable sentence directly to df2-1 (not via DF5.5).

## Session Log

- 2026-08-12 (close): Pass 3 complete (3 verifiers: V3-A 9, V3-B 8, V3-XC 10 findings — 1 BLOCKER, all structural checks clean). Final fix wave (4 fixers + parent epic sync) resolved all 27. Verified post-fix: 31 stories / 123 pts, epics DF1 32 · DF2 34 · DF3 24 · DF4 10 · DF5 17 · DF6 6, sprints 48/50/25, zero TODO/FIXME, graph acyclic. CAMPAIGN COMPLETE — 246 findings total (Pass1 121 + wave1 8 + Pass2 90 + Pass3 27), all resolved.

- 2026-08-12 (cont.): Fix wave 2 complete. 5 story fixers + epic reconciler. All 90 Pass-2 findings resolved + 8 new mid-wave findings (DF1-P2-17/-18, DF2-P2-16, DF45-P2-12/-13, DF56-P2-14, W2-DF3's 3 ratified in-place decisions). DF2.9 → v5-S2; totals 123 pts (48/50/25) reconciled across epics/register/yaml; DD-13 records the +12 re-baseline. Pass 3 dispatched.

- 2026-08-12 (cont.): Fix wave 1 complete. 5 story fixers + 1 epic fixer. All 121 Pass-1 findings resolved; 8 new findings discovered mid-wave, all fixed (DF1-P1-20, DF2-P1-24/25/26, DF3-P1-22, DF45-P1-23, XC-P1-18 cycle-break, P1.18 descheduled). Re-pointing: 31 stories / 123 pts (S1 53 · S2 45 · S3 25). Pass 2 watch items: qds-cost CLI consumer; DF5.5 amendment-E/DF3.6 coherence.

- 2026-08-12: Campaign opened. Pass 1 dispatched: R-DF1 (8 stories), R-DF2 (9), R-DF3 (6), R-DF45 (df4-1, df4-2, df5-5), R-DF56 (df5-1..5-4, df6-1), R-XC (cross-cutting: dependency graph, contract drift, sequencing).
