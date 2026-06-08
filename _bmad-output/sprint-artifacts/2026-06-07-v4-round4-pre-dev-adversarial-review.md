# QDS-Factory v4 — Pre-Dev Adversarial Review Campaign (Round 4)

**Date:** 2026-06-07
**Status:** ✅ ROUND 4 COMPLETE — All 208 findings (84 original + 124 W5 re-fix) resolved
**Scope:** 5 stories (P1.7, P1.10, P1.14, P1.16, P1.17)
**Prior reviews:**
- Round 1 (`2026-06-06-v4-pre-dev-adversarial-review.md`): P0.3, P0.7, P0.9, P0.11, P1.1 — 124 findings resolved
- Round 2 (`2026-06-07-v4-round2-pre-dev-adversarial-review.md`): P0.2, P1.2, P1.3, P1.6, P1.13 — 90 findings resolved
- Round 3 (`2026-06-07-v4-round3-pre-dev-adversarial-review.md`): P0.5, P0.10, P1.5, P1.9, P1.15 — 107 findings resolved
**Warren decision:** Applied (P0.1, P0.4, P0.8, P1.4, P1.8 killed; sprint-status.yaml updated ✅)
**Method:** 5 parallel PhD-level adversarial reviewers → collated tracker → wave protocol
**Selection rationale:** P1.17 is THE phase-1 exit gate (8-clause assertion harness). P1.7 (LSP gate), P1.10 (Telegram approve/resume), P1.16 (audit chain), P1.14 (outcome record) are its four load-bearing feeder stories — all four are directly referenced in P1.17's clause mapping.

---

## Pre-scan Observations (parent agent)

1. P1.10 deps list P0.8 (killed) and P1.8 (killed) as predecessors. Dead dependency references.
2. P1.17 overview references "Archon run" — Round 1 CC-3 replaced Archon/dag-executor refs with Warren-neutral. Check for residuals.
3. P1.16 overview references "Archon run-log" — same concern.
4. P1.14 mentions `retry_class` field with `null` — Round 2 CC-2 resolved `exit_class` as mandatory non-null. Check if `retry_class` has same constraint.
5. P1.7 merged-output schema uses `exit_class` — must match Round 2 CC-2 resolution.

---

## Status Dashboard

| Wave | Status | Findings | Done | Remaining |
|------|--------|----------|------|-----------|
| Initial Scan | ✅ COMPLETE | 82 total | 5/5 reviewers | 0 |
| Wave 0 — Cross-cutting | ✅ COMPLETE | 5 CC items | 5 | 0 |
| Wave 1 — BLOCKERs | ✅ COMPLETE | 8 | 8 | 0 |
| Wave 2 — HIGHs | ✅ COMPLETE | 27 | 27 | 0 |
| Wave 3 — MEDIUMs | ✅ COMPLETE | 32 | 32 | 0 |
| Wave 4 — LOWs | ✅ COMPLETE | 17 | 17 | 0 |
| Wave 5 — Verification | ✅ COMPLETE | 124 | 0 | 124 |
| Wave 5b+5c — Re-fix | ✅ COMPLETE | 124 | 124 | 0 |

## Per-Story Progress

| Story | Title | SP | B | H | M | L | Total | W0 | W1 | W2 | W3 | W4 | W5 |
|-------|-------|-----|---|---|---|---|-------|----|----|----|----|-----|-----|
| P1.7 | post-edit-lsp-gate | 3 | 1 | 5 | 7 | 4 | 17 | ✅ | ✅ | ✅ | ✅ | ✅ | 25 (0B/5H/13M/7L) |
| P1.10 | execution-policy-approve-resume | 4 | 2 | 7 | 6 | 2 | 17 | ✅ | ✅ | ✅ | ✅ | ✅ | 23 (3B/5H/8M/7L) |
| P1.14 | outcome-record-router-select | 3 | 2 | 4 | 5 | 3 | 14 | ✅ | ✅ | ✅ | ✅ | ✅ | 24 (3B/7H/7M/7L) |
| P1.16 | audit-chain-reconstructable | 4 | 1 | 5 | 7 | 4 | 17 | ✅ | ✅ | ✅ | ✅ | ✅ | 27 (2B/6H/13M/6L) |
| P1.17 | phase1-make-or-break-gate | 3 | 2 | 6 | 7 | 4 | 19 | ✅ | ✅ | ✅ | ✅ | ✅ | 25 (2B/7H/10M/6L) |
| **Totals** | | **17** | **8** | **27** | **32** | **17** | **84** | | | | | | **124** |

---

## Cross-Cutting Themes

### CC-1: Archon Residual Terminology (touches P1.7, P1.10, P1.16, P1.17)

**Stories:** P1.7-B1, P1.16-B1, P1.16-L1, P1.16-L2, P1.17-B2
**Problem:** Despite R1 CC-3 resolving Archon→Warren terminology, residuals persist in 4 of 5 stories. P1.16 has 6 occurrences of "Archon run-log"/"Archon run". P1.17 clause 5 AC still says "Archon run". P1.7 cites stale "dag-executor".
**Fix per story:**
- P1.7: Replace "dag-executor" → "Warren `qds-mkbrk` DAG" or "implement node"
- P1.10: Replace any "Archon" → "Warren" in approve/resume prose
- P1.16: Replace all 6 "Archon" occurrences → "Warren run" / "run log" / "Warren bash node"
- P1.17: Replace "Archon run" in clause 5 AC → "Warren run"; replace "Archon `qds-mkbrk` DAG" in overview → "Warren `qds-mkbrk` DAG"

### CC-2: Dead Dependency References to Killed Stories (touches P1.10, P1.17)

**Stories:** P1.10-B01, P1.10-B02, P1.17-B1
**Problem:** P0.8 and P1.8 were killed by Warren decision but P1.10 lists them as predecessors. P0.8 was the only story that would build the Hermes-Telegram gateway P1.10 depends on. P1.17 clause 8 transitively depends on P1.10 which transitively depends on the killed P0.8.
**Fix per story:**
- P1.10: Remove P0.8 and P1.8 from dependency edges; add note that P1.10 itself absorbs the Hermes-Telegram gateway wiring (was P0.8 scope)
- P1.17: Verify clause 8 still resolves after P1.10 dep cleanup; add note that P1.10 now owns gateway creation

### CC-3: Missing exit_class Acknowledgment (touches P1.14, P1.16)

**Stories:** P1.14 (retry_class null semantics), P1.16-L4
**Problem:** Verified-correct element mandates exit_class non-null across ALL stories. P1.16's audit-walk report schema doesn't mention exit_class. P1.14 uses `retry_class` with null semantics that may conflict.
**Fix per story:**
- P1.14: Document that retry_class is distinct from exit_class; clarify null semantic ("first pass, no retry attempted")
- P1.16: Add note that audit-walk tool exit behavior maps to exit_class semantics

### CC-4: Vague Join Keys / Unimplementable Contract Gaps (touches P1.14, P1.16)

**Stories:** P1.16-H1, P1.16-H2, P1.16-H3, P1.14-B1
**Problem:** Multiple hops/queries lack concrete FK/API specs. Developer cannot implement without guessing the storage location or join key.
**Fix per story:**
- P1.16: Specify exact field/API for hops 1, 8, 9 (run-log sink path, node output JSON structure, pi-lens artifact path)
- P1.14: Specify exact storage location for outcome records and how role/model tier is resolved

### CC-5: Incomplete Dependency Edge Lists (touches P1.7, P1.16)

**Stories:** P1.16-H5, P1.16-M2, P1.7-H5
**Problem:** Dependency lists are misleadingly narrow. P1.16 lists only P1.15, P1.13, P1.11 but hops 7-9 need P1.3, P1.6, P1.5. P1.7 doesn't list P0.6 for e2e waiver enum alignment.
**Fix per story:**
- P1.16: Add transitive predecessors or explicit "walks stores populated by P1.1–P1.15 transitively"
- P1.7: Add P0.6 dependency for waiver enum alignment

---

## Verified-Correct Elements (DO NOT REGRESS)

From prior rounds — fixes contradicting these must surface as deliberate supersedure:

- **P0.3:** `exit_class` mandatory non-null string (`"transient"`|`"overflow"`|`"logic"`)
- **P0.3:** Model IDs use generational aliases (e.g., `claude-sonnet-4-6`); OpenRouter: `openrouter/z-ai/glm-4.6`, `openrouter/moonshotai/kimi-k2`
- **P0.9:** Hindsight recall: `/v1/default/banks/{bank_id}/memories/recall` (has `/memories/` prefix)
- **P0.7:** Paperclip `local_trusted` auth mode (no bearer at app level)
- **P1.6:** `WarrenClient` is NEW QDS-specific TS client wrapping `POST /api/workflows/{name}/run` + SSE
- **P1.13:** Cost ceiling rounding: `Math.ceil(Number((usd * 100).toFixed(10)))`
- **P1.2:** Issue-create: `POST /companies/:companyId/issues`, `companyId` from `PAPERCLIP_COMPANY_ID`
- **P0.5:** TDI: `$PI_LENS_HOME/cache/actionable-warnings.json`; `resolveTdiSignal(): TdiSignal`
- **P0.10:** GitNexus `impact()` returns `risk: "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"` (no `blastRadius` number)
- **P1.5:** Model router: `anthropic/claude-opus` invalid; use `claude-opus-4-8` generational alias
- **P1.9:** `retryCount >= 8` caps completed retries at 8
- **P1.15:** Path traversal prevention uses `realpath` canonicalization (not simple `..` check)
- **R2 CC-1:** `originKind`/`originId` settable via service layer (not REST if stripped)
- **R2 CC-2:** `exit_class` mandatory non-null across ALL stories (no `null` variant)
- **R2 CC-3:** P1.6 writes `costTotal` raw float; P1.13 owns float→cents conversion

---

## Findings

### P1.7 — post-edit-lsp-gate (17 findings)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.7-B1 | BLOCKER | dead-reference | Stale "dag-executor" citation — R1 CC-3 replaced with Warren-neutral but P1.7 still references dag-executor in overview | ✅ DONE |
| P1.7-H1 | HIGH | contract-mismatch | `coms_await` vs NDJSON stream mismatch — P1.6 uses NDJSON SSE stream but P1.7 gated-output schema assumes `coms_await` polling pattern | ✅ DONE |
| P1.7-H2 | HIGH | undefined-field | `errorCount` field referenced in merged-output schema but undefined — no source specifies where this count comes from | ✅ DONE |
| P1.7-H3 | HIGH | enum-divergence | Waiver enum diverges from P0.6 — P1.7 defines waiver categories differently than P0.6 pi-lens waiver taxonomy | ✅ DONE |
| P1.7-H4 | HIGH | missing-dep | P0.6 dependency missing for e2e — P1.7 e2e test needs P0.6 waiver types but P0.6 not listed as dependency | ✅ DONE |
| P1.7-H5 | HIGH | contract-gap | `changed_files` union semantics undefined — multiple workers produce changed_file lists but merge/dedup strategy not specified | ✅ DONE |
| P1.7-M1 | MEDIUM | ac-ambiguity | AC-1 binary pass/fail but no guidance on partial LSP success (some files clean, some dirty) | ✅ DONE |
| P1.7-M2 | MEDIUM | schema-gap | Merged-output JSON schema missing `lsp_diagnostics` array shape — developer cannot validate gate output | ✅ DONE |
| P1.7-M3 | MEDIUM | wiring-claim | "No emit with dirty diagnostics" claim depends on streaming architecture but story doesn't specify where gate intercepts the stream | ✅ DONE |
| P1.7-M4 | MEDIUM | test-gap | No unit test DoD for the waiver-path (all diagnostics waived → emit proceeds) | ✅ DONE |
| P1.7-M5 | MEDIUM | cross-cut-consistency | exit_class values in gate output must match verified-correct `"transient"`|`"overflow"`|`"logic"` enum | ✅ DONE |
| P1.7-M6 | MEDIUM | ungrounded-api | LSP diagnostic format not specified — assume `DiagItem { file, line, severity, message }` but story doesn't define it | ✅ DONE |
| P1.7-M7 | MEDIUM | dod-gap | No perf DoD item — gate must run in ≤2s per P1.6 NFR but no test enforces it | ✅ DONE |
| P1.7-L1 | LOW | citation-imprecision | File:line citations for coms stream capture are ranges, not exact lines | ✅ DONE |
| P1.7-L2 | LOW | dod-gap | No DoD item for edge case: zero changed files (no workers produced output) | ✅ DONE |
| P1.7-L3 | LOW | other | Story SP estimate may be tight — LSP integration + streaming gate + waiver logic could be 5SP | ✅ DONE |
| P1.7-L4 | LOW | other | No mention of LSP server startup latency — first invocation cold-start could violate ≤2s NFR | ✅ DONE |

#### Wave 5 Verification Findings (25 total: 0B/5H/13M/7L)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.7-V5-H1 | HIGH | dead-reference | `coms_await` polling reference retained in anti-pattern clause (3 occurrences) | ✅ DONE |
| P1.7-V5-H2 | HIGH | schema-gap | `errorCount` dual-definition: top-level sum vs raw details array length — derivation methods disagree | ✅ DONE |
| P1.7-V5-H3 | HIGH | contract-mismatch | `lsp_diagnostics` merged-schema field not cross-referenced with P1.6 base schema — additive extension undocumented | ✅ DONE |
| P1.7-V5-H4 | HIGH | test-gap | No test for mixed clean-and-dirty union (some files pass, others fail, no waivers) | ✅ DONE |
| P1.7-V5-H5 | HIGH | missing-guard | Symlink-based worktree escape not guarded — realpath resolves symlink targets outside worktree | ✅ DONE |
| P1.7-V5-M1 | MEDIUM | schema-gap | `severity` enum under-specified — no handling for LSP `info`/`hint` diagnostics | ✅ DONE |
| P1.7-V5-M2 | MEDIUM | cross-cut-consistency | `lsp_diagnostics` field name collides with pi-lens tool command name | ✅ DONE |
| P1.7-V5-M3 | MEDIUM | dead-reference | `qds-mkbrk DAG` terminology in INV-4 stderr reference — legacy artifact | ✅ DONE |
| P1.7-V5-M4 | MEDIUM | missing-guard | No idempotency guard on waiver record write — retry could double-count waivers | ✅ DONE |
| P1.7-V5-M5 | MEDIUM | ac-ambiguity | AC-1 errorCount derivation contradicts schema definition (details array length vs sum of per-file counts) | ✅ DONE |
| P1.7-V5-M6 | MEDIUM | test-gap | No test for malformed lsp_diagnostics JSON output (pi-lens parse failure) | ✅ DONE |
| P1.7-V5-M7 | MEDIUM | dod-gap | No DoD box verifying top-level errorCount = SUM(per-file) not raw details length | ✅ DONE |
| P1.7-V5-M8 | MEDIUM | security-gap | INV-2 worktree constraint lacks concrete enforcement mechanism (realpath + prefix match) | ✅ DONE |
| P1.7-V5-M9 | MEDIUM | cross-cut-consistency | `partial` field semantics undefined for gate context — always false in P1.7's binary gate | ✅ DONE |
| P1.7-V5-M10 | MEDIUM | missing-guard | No maximum bound on changed_files union size — pathological worker could produce unbounded set | ✅ DONE |
| P1.7-V5-M11 | MEDIUM | cross-cut-consistency | Waiver `fallback` is single literal string, not extensible enum | ✅ DONE |
| P1.7-V5-M12 | MEDIUM | ac-ambiguity | AC-2 `waivers: []` default makes accidental omission undetectable — explicitly-written test needed | ✅ DONE |
| P1.7-V5-M13 | MEDIUM | dod-gap | No DoD box for `--mode json`/`--mode rpc` invocation specificity | ✅ DONE |
| P1.7-V5-L1 | LOW | dod-gap | No DoD test for partial worker NDJSON stream (truncated changed_files) | ✅ DONE |
| P1.7-V5-L2 | LOW | cross-cut-consistency | Model ID references absent — confirmed correct (no model dependency), not a finding | ⬜ N/A |
| P1.7-V5-L3 | LOW | other | `pi-team-launch.sh` vs `scripts/pi-team-launch.sh` path inconsistency between Overview and Files to Modify | ✅ DONE |
| P1.7-V5-L4 | LOW | dod-gap | No DoD test for set-union deduplication correctness (overlapping changed_files) | ✅ DONE |
| P1.7-V5-L5 | LOW | ac-ambiguity | AC-3 waiver reason alignment with P0.6 taxonomy — no concrete verification mechanism | ✅ DONE |
| P1.7-V5-L6 | LOW | dod-gap | No DoD test for stderr waiver log format validation (JSON-parseable, one per waiver) | ✅ DONE |
| P1.7-V5-L7 | LOW | other | SP note "may warrant 5SP" — no concrete criteria for when estimate should be revised | ✅ DONE |

### P1.10 — execution-policy-approve-resume (17 findings)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.10-B1 | BLOCKER | dead-reference | Dead P0.8/P1.8 deps in story prose — killed stories still listed as predecessors | ✅ DONE |
| P1.10-B2 | BLOCKER | missing-builder | Hermes-Telegram gateway has no builder — P0.8 was the only story that would build it. P1.10 must absorb gateway creation or need new predecessor | ✅ DONE |
| P1.10-H1 | HIGH | missing-auth | No callback authentication — any POST with right JSON shape could resume a run. HMAC signature or shared-secret needed | ✅ DONE |
| P1.10-H2 | HIGH | missing-timeout | No approval timeout — paused runs wait forever if stakeholder never responds. Need TTL + auto-reject or escalation | ✅ DONE |
| P1.10-H3 | HIGH | race-condition | Concurrent approve/reject taps — two humans could tap simultaneously, causing double-resume or resume-after-halt | ✅ DONE |
| P1.10-H4 | HIGH | resilience-gap | No Telegram outage handling — if Telegram API is down, approve/reject path is completely broken with no fallback | ✅ DONE |
| P1.10-H5 | HIGH | test-gap | No CI-mockable path — "real tap" impossible in headless CI. Need mock Telegram webhook or deterministic test harness | ✅ DONE |
| P1.10-H6 | HIGH | ungrounded-citation | File:line citations are ranges, not specific lines. "approvals.ts:5-28" doesn't name the issueId column line | ✅ DONE |
| P1.10-H7 | HIGH | contract-gap | `executionPolicy` enum values not defined — what are valid values? "manual" only? "auto" with conditions? | ✅ DONE |
| P1.10-M1 | MEDIUM | ac-ambiguity | AC for reject path says "halts cleanly" but doesn't specify what clean halt means (issue status? run status? notification?) | ✅ DONE |
| P1.10-M2 | MEDIUM | schema-gap | Approval record schema doesn't include `respondedAt` timestamp — no audit trail of when human responded | ✅ DONE |
| P1.10-M3 | MEDIUM | wiring-claim | "Inline approve/reject" in Telegram assumes Hermes bot has inline keyboard support but doesn't verify | ✅ DONE |
| P1.10-M4 | MEDIUM | cross-cut-consistency | Issue status transitions (paused→running, paused→halted) must align with Paperclip status enum from P1.1/P1.2 | ✅ DONE |
| P1.10-M5 | MEDIUM | missing-guard | No guard against approving an already-completed run — stale approval tap could restart a finished workflow | ✅ DONE |
| P1.10-M6 | MEDIUM | dod-gap | No DoD item for the Telegram bot registration step — bot must be registered before approve/reject works | ✅ DONE |
| P1.10-L1 | LOW | dead-reference | FR references may include killed P0.8 FRs — verify all FR citations are still valid | ✅ DONE |
| P1.10-L2 | LOW | other | Story mentions §12.2 OQ-3 fallback but doesn't define what this is or when it applies | ✅ DONE |

#### Wave 5 Verification Findings (23 total: 3B/5H/8M/7L)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.10-V5-B1 | BLOCKER | security-gap | Telegram callback_data exceeds 64-byte hard limit — JSON payload ~160+ bytes | ✅ DONE |
| P1.10-V5-B2 | BLOCKER | ungrounded-api | No webhook endpoint route defined for Telegram callback reception | ✅ DONE |
| P1.10-V5-B3 | BLOCKER | schema-gap | `decidedByUserId` ambiguous — Telegram chat ID vs Paperclip user ID resolution undefined | ✅ DONE |
| P1.10-V5-H1 | HIGH | dead-reference | P0.8 reference in Dependency edges contradicts "absorbed" narrative | ✅ DONE |
| P1.10-V5-H2 | HIGH | cross-cut-consistency | Issue status transition values not confirmed against P1.1/P1.2 enum | ✅ DONE |
| P1.10-V5-H3 | HIGH | race-condition | TTL auto-reject vs human approve race — no ordered comparison specified | ✅ DONE |
| P1.10-V5-H4 | HIGH | missing-guard | No rate-limit on Telegram webhook endpoint — replay/abuse possible | ✅ DONE |
| P1.10-V5-H5 | HIGH | schema-gap | `issue_execution_decisions` table fields not enumerated — schema contract incomplete | ✅ DONE |
| P1.10-V5-M1 | MEDIUM | contract-mismatch | WarrenClient resume API path not specified — how does gateway actually resume? | ✅ DONE |
| P1.10-V5-M2 | MEDIUM | test-gap | No test for "approve tap on already-completed run" (non-paused state guard) | ✅ DONE |
| P1.10-V5-M3 | MEDIUM | ac-ambiguity | AC-2 "clean halt" bundles 4 assertions into one AC — partial satisfaction undefined | ✅ DONE |
| P1.10-V5-M4 | MEDIUM | dod-gap | DoD has 14 items — exceeds 8-12 guideline | ✅ DONE |
| P1.10-V5-M5 | MEDIUM | wiring-claim | `config/telegram.env.example` listed but env var names not enumerated | ✅ DONE |
| P1.10-V5-M6 | MEDIUM | cross-cut-consistency | `via` enum includes `"telegram_plugin"` but plugin SDK is BLOCKED — phantom value | ✅ DONE |
| P1.10-V5-M7 | MEDIUM | missing-guard | CLI fallback `qds approve` has no authentication specified | ✅ DONE |
| P1.10-V5-M8 | MEDIUM | contract-mismatch | Warren RESUMABLE set cited from P1.9, not P1.6 — Paperclip issue vs Warren run status unclear | ✅ DONE |
| P1.10-V5-L1 | LOW | ac-ambiguity | AC-3 "stays paused" is temporal — no testable time bound for gate assertion | ✅ DONE |
| P1.10-V5-L2 | LOW | dod-gap | No DoD test for executionPolicy backward-compatibility (no gate = no pause) | ✅ DONE |
| P1.10-V5-L3 | LOW | enum-divergence | `notifyChannel` includes `"cli"` but no CLI notification path defined | ✅ DONE |
| P1.10-V5-L4 | LOW | test-gap | No test for multiple simultaneous paused runs with independent decisions | ✅ DONE |
| P1.10-V5-L5 | LOW | cross-cut-consistency | Health-check endpoint `GET /hermes/telegram/health` not in Files to Modify | ✅ DONE |
| P1.10-V5-L6 | LOW | other | "Wiring closed" section too dense — hard to verify each integration point independently | ✅ DONE |
| P1.10-V5-L7 | LOW | other | `timeoutMs` sourcing priority between executionPolicy and env var is ambiguous | ✅ DONE |

### P1.14 — outcome-record-router-select (14 findings)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.14-B1 | BLOCKER | schema-impossible | `per_role_model_tier` field impossible without `role` column — agents table has no role column to group by | ✅ DONE |
| P1.14-B2 | BLOCKER | undecided-storage | Outcome record storage location undecided — story says "zero added inference" but doesn't say WHERE the record is written or read from | ✅ DONE |
| P1.14-H1 | HIGH | semantic-ambiguity | `retry_class` null semantic — story uses null for "first pass" but verified-correct element says exit_class is mandatory non-null; clarify distinction | ✅ DONE |
| P1.14-H2 | HIGH | undefined-field | `first_pass_accept` field undefined — what determines "first pass acceptance"? No threshold or criteria given | ✅ DONE |
| P1.14-H3 | HIGH | undefined-source | `task_type` field source undefined — where does the task type come from? Seeds? Paperclip? Not specified | ✅ DONE |
| P1.14-H4 | HIGH | missing-guard | No cost_events guard — story references cost aggregation but doesn't guard against missing cost_events rows | ✅ DONE |
| P1.14-M1 | MEDIUM | ac-ambiguity | AC for "zero added inference" is untestable — how to verify no extra LLM calls were made? | ✅ DONE |
| P1.14-M2 | MEDIUM | schema-gap | Outcome record schema has 11 fields but no Zod/JSON validation schema defined | ✅ DONE |
| P1.14-M3 | MEDIUM | wiring-claim | "Read from native ledger sites" claims specific file:line refs but doesn't verify they exist in current codebase | ✅ DONE |
| P1.14-M4 | MEDIUM | cross-cut-consistency | Model tier extraction must align with P1.5 model router aliases — verify `per_role_model_tier` uses generational aliases | ✅ DONE |
| P1.14-M5 | MEDIUM | test-gap | No DoD item for verifying all 11 fields are populated on a real run | ✅ DONE |
| P1.14-L1 | LOW | other | Story SP may be tight — 11-field schema + 7 data sources + aggregation logic could exceed 3SP | ✅ DONE |
| P1.14-L2 | LOW | citation-imprecision | File:line citations are ranges; exact join-key column lines not specified | ✅ DONE |
| P1.14-L3 | LOW | other | No mention of what happens when run has zero cost events — is outcome record still valid? | ✅ DONE |

#### Wave 5 Verification Findings (24 total: 3B/7H/7M/7L)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.14-V5-B1 | BLOCKER | schema-gap | `run_id` typed as `z.string().uuid()` but Warren runId format not guaranteed UUID | ✅ DONE |
| P1.14-V5-B2 | BLOCKER | contract-mismatch | `first_pass_accept` references `exit_class` but OutcomeRecord schema has no `exit_class` field | ✅ DONE |
| P1.14-V5-B3 | BLOCKER | dead-reference | Native-site reader references `activity_log` — no `activity_log` table defined in any Phase-1 story | ✅ DONE |
| P1.14-V5-H1 | HIGH | ungrounded-api | `recordOutcome(runId)` function referenced but no API/path/invocation mechanism specified | ✅ DONE |
| P1.14-V5-H2 | HIGH | missing-guard | No guard against outcome record for run still in progress (non-terminal heartbeat_runs) | ✅ DONE |
| P1.14-V5-H3 | HIGH | wiring-claim | Storage location "alongside P1.15 run-log" contradicts Technical Notes "heartbeat_runs.usageJson.outcomeRecord" | ✅ DONE |
| P1.14-V5-H4 | HIGH | schema-gap | `task_type` reads from `issues.originKind` but runId→issueId join path undocumented | ✅ DONE |
| P1.14-V5-H5 | HIGH | ac-ambiguity | AC-3 determinism assertion is P1.5's guarantee, not P1.14's — rewrite to match P1.14's actual scope | ✅ DONE |
| P1.14-V5-H6 | HIGH | cross-cut-consistency | `per_role_model_tier` example cites P1.6 model but P1.6 workers use different model than router assigns | ✅ DONE |
| P1.14-V5-H7 | HIGH | test-gap | No test for router rationale persistence format/content — only "persisted alongside" asserted | ✅ DONE |
| P1.14-V5-M1 | MEDIUM | missing-guard | No timeout guard on `recordOutcome` — hung native-site read could block indefinitely | ✅ DONE |
| P1.14-V5-M2 | MEDIUM | schema-gap | `cost_data_available: false` ambiguity — "no data" vs "free run" (all zero cost_events) conflated | ✅ DONE |
| P1.14-V5-M3 | MEDIUM | cross-cut-consistency | `retry_class`/`exit_class` share same enum values — naming collision risk in code reading both | ✅ DONE |
| P1.14-V5-M4 | MEDIUM | dod-gap | No DoD item verifying outcome record queryable by runId (P1.17 clause 6 depends on it) | ✅ DONE |
| P1.14-V5-M5 | MEDIUM | missing-guard | No validation that heartbeatRunId for cost aggregation matches outcome record runId (retry scenario) | ✅ DONE |
| P1.14-V5-M6 | MEDIUM | ungrounded-api | No spec for how recordOutcome discovers heartbeatRunId from runId — lookup undocumented | ✅ DONE |
| P1.14-V5-M7 | MEDIUM | cross-cut-consistency | Archetype "A".."F" enum values undocumented — P1.5 defines mapping but P1.14 doesn't reference it | ✅ DONE |
| P1.14-V5-L1 | LOW | ac-ambiguity | AC-2 idempotency "contents are identical" — floating-point cost_cents comparison semantics undefined | ✅ DONE |
| P1.14-V5-L2 | LOW | dead-reference | `FR-MG-9` cited as retry_class source but not in Spec Reference section | ✅ DONE |
| P1.14-V5-L3 | LOW | dod-gap | Files to Modify lists `router-rationale-store.ts` but Technical Notes say rationale reuses P1.5's usageJson | ✅ DONE |
| P1.14-V5-L4 | LOW | dod-gap | No DoD item for Zod schema validation test in isolation | ✅ DONE |
| P1.14-V5-L5 | LOW | test-gap | No test for `per_role_model_tier` aggregation logic — agentId→RoleAlias mapping undocumented | ✅ DONE |
| P1.14-V5-L6 | LOW | cross-cut-consistency | NFR-COST-3 cited but no wall-clock budget for recordOutcome itself | ✅ DONE |
| P1.14-V5-L7 | LOW | missing-guard | No error handling for heartbeat_runs row existing but issues row missing (orphan run) | ✅ DONE |

### P1.16 — audit-chain-reconstructable (17 findings)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.16-B1 | BLOCKER | dead-reference | "Archon run-log"/"Archon run" used 6 times — lines 14, 19, 27, 38, 40-41 all carry stale "Archon" framing despite R1 CC-3 fix | ✅ DONE |
| P1.16-H1 | HIGH | contract-gap | Hop 1 join key vague — "PR branch/worktree id ↔ run id (run-log header)" is not a concrete FK or API call. Must name exact field/API from P1.15 run-log sink | ✅ DONE |
| P1.16-H2 | HIGH | contract-gap | Hop 8 "run id ↔ launcher invocation; agent names/models/coms log in node output + ~/.pi/coms/" unimplementably vague — specify Warren bash node stdout JSON structure | ✅ DONE |
| P1.16-H3 | HIGH | contract-gap | Hop 9 "per-agent turn-end report" — no concrete storage location or retrieval API. Specify pi-lens artifact path keyed by runId | ✅ DONE |
| P1.16-H4 | HIGH | missing-guard | No resume/checkpoint behavior — walk interruption means full restart from hop 1. Must document (acceptable for ≤30s) or specify partial-progress reporting | ✅ DONE |
| P1.16-H5 | HIGH | contract-gap | Dependency list incomplete — only lists P1.15, P1.13, P1.11 but hops 7-9 need P1.3, P1.6, P1.5. Add transitive deps | ✅ DONE |
| P1.16-M1 | MEDIUM | ac-ambiguity | AC-1 binary pass/fail but no guidance on 9/10 hops — report must show which hop failed with diagnostic: `{name, resolved, key, source, error?}` | ✅ DONE |
| P1.16-M2 | MEDIUM | wiring-claim | "No missing hop" guarantee depends on 10 predecessor stores — Seeds .seeds/issues.jsonl owned by P1.3 (NOT listed dep) | ✅ DONE |
| P1.16-M3 | MEDIUM | ungrounded-api | Hop 6 citations "approvals.ts:5-28" are file ranges, not specific join-key column lines. Add citation caveat or specify exact line | ✅ DONE |
| P1.16-M4 | MEDIUM | schema-gap | INV-3 forbids fabricated cost field but doesn't handle future issues table cost column — make invariant defensive | ✅ DONE |
| P1.16-M5 | MEDIUM | cross-cut-consistency | §13 clause mapping verified correct (clause 5 = audit chain, clause 6 = per-issue spend) — cite exact PRD line numbers for traceability | ✅ DONE |
| P1.16-M6 | MEDIUM | dod-gap | No latency-test DoD item — NFR-OBS-4(a) ≤30s and NFR-COST-2 ≤2s asserted but no perf test DoD box enforces them | ✅ DONE |
| P1.16-M7 | MEDIUM | dead-reference | Hop list says "epic → Seeds stories" but no "epic" row in Paperclip — epic is the root issue (parentId = null). Clarify | ✅ DONE |
| P1.16-L1 | LOW | dead-reference | Hop 1 references "FR-OR-7" — Archon-era FR, verify it maps to P1.15 run-log persistence or update | ✅ DONE |
| P1.16-L2 | LOW | dead-reference | Overview line 19 "Archon run-log" → should be "run log (persisted by P1.15)" | ✅ DONE |
| P1.16-L3 | LOW | dod-gap | No DoD item for `--issue <id>` alternative invocation path mentioned in E2E Slice | ✅ DONE |
| P1.16-L4 | LOW | other | Audit-walk report has no exit_class field — should acknowledge exit_class convention per verified-correct | ✅ DONE |

#### Wave 5 Verification Findings (27 total: 2B/6H/13M/6L)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.16-V5-B1 | BLOCKER | schema-gap | Hop 9 pi-lens cache path contradicts verified-correct TDI reference ($PI_LENS_HOME/cache/{runId}/ vs actionable-warnings.json) | ✅ DONE |
| P1.16-V5-B2 | BLOCKER | schema-gap | Hop 10 bank name uses ambiguous `{repo}-<dept>-meta` placeholder — no `<dept>` value defined anywhere | ✅ DONE |
| P1.16-V5-H1 | HIGH | contract-mismatch | AC-2 budget comparison ambiguous — agent vs company budgetMonthlyCents, must check BOTH | ✅ DONE |
| P1.16-V5-H2 | HIGH | missing-guard | No company-id scoping on hops 2-7 FK lookups — cross-tenant row could silently join | ✅ DONE |
| P1.16-V5-H3 | HIGH | dead-reference | FR-OR-7 defensive parenthetical retained — double-justification is confusing | ✅ DONE |
| P1.16-V5-H4 | HIGH | ungrounded-api | Hop 8 `agents` array not in P1.6 merged-output schema — walker references nonexistent field | ✅ DONE |
| P1.16-V5-H5 | HIGH | test-gap | No test for `--issue <id>` invocation path exercising hop-1 skip + hops 2-10 resolution | ✅ DONE |
| P1.16-V5-H6 | HIGH | cross-cut-consistency | exit_class not in audit-walk report schema despite being a run property consumers need | ✅ DONE |
| P1.16-V5-M1 | MEDIUM | ac-ambiguity | AC-3 "no cost_events row" ambiguous — by heartbeatRunId or by issueId? | ✅ DONE |
| P1.16-V5-M2 | MEDIUM | contract-mismatch | Report schema missing hop-level key/source fields that per-hop structure defines | ✅ DONE |
| P1.16-V5-M3 | MEDIUM | wiring-claim | Hop 1 depends on P1.15 run-log but P1.15 doesn't define queryable API for run-log lookup by pr_url | ✅ DONE |
| P1.16-V5-M4 | MEDIUM | dod-gap | No DoD item for per-hop cost SUM isolation test (NFR-COST-2 ≤2s independent of full walk) | ✅ DONE |
| P1.16-V5-M5 | MEDIUM | missing-guard | No guard for empty .seeds/issues.jsonl — empty file ≠ missing file, different semantics | ✅ DONE |
| P1.16-V5-M6 | MEDIUM | cross-cut-consistency | `agents.reportsTo` field referenced but no sibling story defines this column in agents table | ✅ DONE |
| P1.16-V5-M7 | MEDIUM | schema-gap | `approvals` and `issue_execution_decisions` tables referenced but no schema or resolution criteria defined | ✅ DONE |
| P1.16-V5-M8 | MEDIUM | contract-mismatch | Budget field name inconsistency — `budgetMonthlyCents` (source) vs `budgetCents` (report) | ✅ DONE |
| P1.16-V5-M9 | MEDIUM | missing-guard | No guard for multiple PRs matching same run (hop 1 ambiguity) | ✅ DONE |
| P1.16-V5-M10 | MEDIUM | dod-gap | No DoD test for epic root resolution via parentId upward walk | ✅ DONE |
| P1.16-V5-M11 | MEDIUM | ac-ambiguity | AC-4 orphan count "0" — no semantics for circular reportsTo chains (cycle detection) | ✅ DONE |
| P1.16-V5-M12 | MEDIUM | cross-cut-consistency | NFR-ACC-1 orphan detection scoped to single-issue, not global — limitation not documented | ✅ DONE |
| P1.16-V5-M13 | MEDIUM | wiring-claim | Hop 7 reads .seeds/issues.jsonl but no read mechanism specified (CLI vs direct file) | ✅ DONE |
| P1.16-V5-L1 | LOW | other | Hop numbering 1-based not explicitly stated — off-by-one risk | ✅ DONE |
| P1.16-V5-L2 | LOW | dod-gap | No backward-compat test — walk on pre-existing Paperclip data (no Seeds/heartbeat_runs) | ✅ DONE |
| P1.16-V5-L3 | LOW | other | No specified stdout output format for CLI (JSON vs pretty-printed vs table) | ✅ DONE |
| P1.16-V5-L4 | LOW | missing-guard | No per-hop timeout — single slow hop could consume entire 30s budget | ✅ DONE |
| P1.16-V5-L5 | LOW | test-gap | No test for concurrent walk safety on same PR — read-only guarantee not stated | ✅ DONE |
| P1.16-V5-L6 | LOW | cross-cut-consistency | `executionPolicy` referenced as JSONB blob but walker doesn't need to parse it — clarify | ✅ DONE |

### P1.17 — phase1-make-or-break-gate (19 findings)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.17-B1 | BLOCKER | dead-reference | P1.10 dead-dep cascade into clause 8 — P1.10 depends on killed P0.8/P1.8; clause 8 transitively broken | ✅ DONE |
| P1.17-B2 | BLOCKER | dead-reference | Residual "Archon run" language in clause 5 AC and overview — R1 CC-3 fix didn't reach P1.17 | ✅ DONE |
| P1.17-H1 | HIGH | contract-gap | Undefined runId source in gate report — `gatePhase1ReportSchema` requires `runId` but doesn't specify which run's ID (the `qds-mkbrk` run? the gate harness run?) | ✅ DONE |
| P1.17-H2 | HIGH | contract-gap | Wrong cost-summary route — cites `GET /companies/:companyId/issues/:id/cost-summary, costs.ts:140` but P1.13 owns cost aggregation; verify route exists after P1.13 implements | ✅ DONE |
| P1.17-H3 | HIGH | missing-dep | Missing P1.15 clause-3 dependency — clause 3 says "qds-mkbrk DAG runs" but P1.15 owns the real-PR surface; dependency edge only mentions P1.10, P1.14, P1.16 explicitly | ✅ DONE |
| P1.17-H4 | HIGH | contract-gap | Ambiguous dev-bank query — clause 7 says `{repo}-dev-meta` / `{repo}` but Hindsight bank naming convention may differ; verify with P1.11 | ✅ DONE |
| P1.17-H5 | HIGH | schema-gap | Gate report has no `wallClockMs` field — `--wall-clock-cap-ms` is a CLI flag but report doesn't record actual elapsed time per clause | ✅ DONE |
| P1.17-H6 | HIGH | test-gap | E2E demo requires "forced single-clause failure (seeded over-cap)" but no mechanism to seed test data into cost_events described | ✅ DONE |
| P1.17-M1 | MEDIUM | ac-ambiguity | Clause 1 "exactly one parent issue" — what if `/qds` handler creates a duplicate on retry? AC doesn't address idempotency | ✅ DONE |
| P1.17-M2 | MEDIUM | contract-gap | `evidenceRef` format unspecified — is it a URL? a file path? a Paperclip issue ID? Developer must guess | ✅ DONE |
| P1.17-M3 | MEDIUM | wiring-claim | "Reuses chain-walker (P1.16)" for clause 5 — but P1.16 may not be merged yet when P1.17 development starts; version coupling risk | ✅ DONE |
| P1.17-M4 | MEDIUM | missing-guard | No guard against sample-repo not existing — gate assumes `./sample-repo` exists but doesn't specify setup/teardown | ✅ DONE |
| P1.17-M5 | MEDIUM | cross-cut-consistency | Clause 2 `originKind='seeds_story'` must match P1.3 exact string — verify no typo divergence | ✅ DONE |
| P1.17-M6 | MEDIUM | schema-gap | INV-1 cites `adapters/registry.ts:468-469` but file:line may shift during P1.1/P1.2 development; add citation caveat | ✅ DONE |
| P1.17-M7 | MEDIUM | dod-gap | No DoD item for gate-report schema validation test — `gatePhase1ReportSchema` Zod parse must be tested | ✅ DONE |
| P1.17-L1 | LOW | citation-imprecision | Technical notes cite multiple file:line ranges; add caveat that lines are best-current-knowledge | ✅ DONE |
| P1.17-L2 | LOW | scope-note | P1.18/P1.19 exclusion is well-documented but no DoD box explicitly tests that excluding them doesn't break clause evaluation | ✅ DONE |
| P1.17-L3 | LOW | other | Story SP may be tight — 8 clause assertions + gate harness + e2e demo + forced-failure test could exceed 3SP | ✅ DONE |
| P1.17-L4 | LOW | other | No mention of gate report persistence — is it stdout-only or also written to a file for post-mortem? | ✅ DONE |

#### Wave 5 Verification Findings (25 total: 2B/7H/10M/6L)

| ID | Sev | Category | Title | Status |
|----|-----|----------|-------|--------|
| P1.17-V5-B1 | BLOCKER | dead-reference | Clause 6 cost-summary route mismatch — cites `GET /companies/:companyId/issues/:id/cost-summary` but P1.13 uses `GET /issues/:id/cost-summary` | ✅ DONE |
| P1.17-V5-B2 | BLOCKER | dead-reference | P1.16 claims clause 6 ownership but P1.17 maps clause 6 to P1.13 — dual-owner ambiguity | ✅ DONE |
| P1.17-V5-H1 | HIGH | cross-cut-consistency | WarrenClient SSE endpoint mismatch — `GET /api/stream/__dashboard__` vs P1.6 actual contract | ✅ DONE |
| P1.17-V5-H2 | HIGH | schema-gap | gatePhase1ReportSchema missing `exit_class` field + prRef nullability semantics undefined | ✅ DONE |
| P1.17-V5-H3 | HIGH | missing-guard | No idempotency guard on gate re-run — second run accumulates artifacts from first | ✅ DONE |
| P1.17-V5-H4 | HIGH | ac-ambiguity | Clause 7 bank name construction undefined — how is repo slug derived from QDS_SAMPLE_REPO? | ✅ DONE |
| P1.17-V5-H5 | HIGH | wiring-claim | Clause 8 HITL exercise in automated gate — no reference to TELEGRAM_MOCK_MODE or CLI fallback | ✅ DONE |
| P1.17-V5-H6 | HIGH | test-gap | Forced-failure test only specifies clause 6 — clauses 4, 5 should each have forced-failure variants | ✅ DONE |
| P1.17-V5-H7 | HIGH | cross-cut-consistency | P1.14 listed as clause-6 predecessor but clause 6 is P1.13's cost SUM — P1.14's role ambiguous | ✅ DONE |
| P1.17-V5-M1 | MEDIUM | ac-ambiguity | Clause 1 idempotency assertion is conditional on P1.2 — rewrite as unconditional end-state check | ✅ DONE |
| P1.17-V5-M2 | MEDIUM | missing-guard | No per-clause timeout — only wall-clock-cap-ms for entire gate | ✅ DONE |
| P1.17-V5-M3 | MEDIUM | dod-gap | No DoD item for gate report file persistence to `.qds/gate-reports/` | ✅ DONE |
| P1.17-V5-M4 | MEDIUM | missing-guard | No validation that clauses run in order — parallel evaluation could miss causality | ✅ DONE |
| P1.17-V5-M5 | MEDIUM | test-gap | No test for empty/missing sample-repo directory handling | ✅ DONE |
| P1.17-V5-M6 | MEDIUM | schema-gap | gatePhase1ReportSchema `durationMs` optional — should be mandatory with default for diagnosability | ✅ DONE |
| P1.17-V5-M7 | MEDIUM | cross-cut-consistency | INV-3 tenant ID hardcoded — should reference shared env var QDS_COMPANY_ID | ✅ DONE |
| P1.17-V5-M8 | MEDIUM | missing-guard | No guard against Warren workflow name mismatch for clause 3 — opaque error if unregistered | ✅ DONE |
| P1.17-V5-M9 | MEDIUM | ac-ambiguity | Clause 8 "live Telegram plugin OR fallback" — plugin is BLOCKED, only gateway path viable | ✅ DONE |
| P1.17-V5-M10 | MEDIUM | missing-guard | No retryCount >= 8 cap assertion in gate — P1.9 misconfiguration would go undetected | ✅ DONE |
| P1.17-V5-L1 | LOW | other | SP note "writes no new product code" misleading — bin/qds-gate.ts IS new code | ✅ DONE |
| P1.17-V5-L2 | LOW | dod-gap | No DoD item verifying stdout is valid JSON (no log spew interleaved) | ✅ DONE |
| P1.17-V5-L3 | LOW | dod-gap | P1.16 merge-order constraint not in Files to Modify or DoD | ✅ DONE |
| P1.17-V5-L4 | LOW | dod-gap | No DoD item for exit-code mapping when multiple clauses fail | ✅ DONE |
| P1.17-V5-L5 | LOW | cross-cut-consistency | costTotal raw float conversion boundary not explicitly stated — gate reads integer cents from P1.13 | ✅ DONE |
| P1.17-V5-L6 | LOW | other | Issue-create route not cited for clause 1 — POST /companies/:companyId/issues | ✅ DONE |

---

## Session Log

| Time | Wave | Action | Details |
|------|------|--------|---------|
| ~18:18 | Pre-scan | Tracker created | Round 4 tracker initialized with 5 stories |
| ~18:18 | Initial Scan | Reviewers dispatched | 5 parallel reviewers spawned (P1.7, P1.10, P1.14, P1.16, P1.17) |
| ~18:25 | Initial Scan | P1.17 reviewer complete | 19 findings (2B/6H/7M/4L) |
| ~18:25 | Initial Scan | P1.7 reviewer complete | 15 findings (1B/5H/7M/4L) → corrected to 17 after recount |
| ~18:25 | Initial Scan | P1.14 reviewer complete | 14 findings (2B/4H/5M/3L) |
| ~18:25 | Initial Scan | P1.10 reviewer complete | 17 findings (2B/7H/6M/2L) |
| ~18:30 | Initial Scan | P1.16 reviewer complete | 17 findings (1B/5H/7M/4L) |
| ~18:32 | Initial Scan | Tracker collated | 84 total findings (8B/27H/32M/17L), 5 CC themes identified |
| ~18:32 | Wave 0 | Dispatching | 5 CC items across all 5 stories, bundled by story file |
| ~18:35 | Wave 0 | Complete | All 5 CC items applied. CC-1: 16 Archon→Warren replacements across 4 stories. CC-2: P1.10 dead deps removed + gateway absorbed; P1.17 dep cascade noted. CC-3: P1.14 retry_class clarified; P1.16 exit_class noted. CC-4: P1.14 storage located; P1.16 hop sources documented. CC-5: P1.7 P0.6 dep enhanced; P1.16 transitive deps added. |
| ~18:42 | Wave 1 | Dispatching | 5 parallel subagents: w1-p17 (P1.7 verify), w1-p110 (P1.10 verify), w1-p114 (P1.14 fix), w1-p116 (P1.16 verify), w1-p117 (P1.17 verify) |
| ~18:50 | Wave 1 | Complete | 8/8 BLOCKERs resolved. 6 verified clean from W0 (P1.7-B1, P1.10-B1/B2, P1.16-B1, P1.17-B1/B2). 2 fixed: P1.14-B1 (Record<RoleAlias,ModelTierAlias> with derivation parenthetical), P1.14-B2 (additive heartbeat_runs.usageJson.outcomeRecord, OR removed). |
| ~19:05 | Wave 2 | Dispatching | 5 parallel subagents: w2-p17 (P1.7, 5H), w2-p110 (P1.10, 7H), w2-p114 (P1.14, 4H), w2-p116 (P1.16, 5H), w2-p117 (P1.17, 6H) |
| ~19:15 | Wave 2 | Complete | 27/27 HIGHs resolved. P1.7: coms_await→NDJSON stream, errorCount defined, waiver enum aligned to P0.6, P0.6 dep enhanced, set-union semantics specified. P1.10: HMAC callback auth, TTL auto-reject, first-decision-wins, outage fallback, TELEGRAM_MOCK_MODE, citation caveat, executionPolicy jsonb defined. P1.14: retry_class enhanced, first_pass_accept derivable, task_type→originKind, INV-5 cost_events guard. P1.16: Hops 1/8/9 concretized, no-checkpoint design note, transitive deps verified. P1.17: runId defined, cost-route delegated, P1.15 clause-3 linked, bank naming clarified, wallClockMs+durationMs added, seed-over-cap mechanism specified. |
| ~19:20 | Wave 3 | Dispatching | 5 parallel subagents: w3-p17 (P1.7, 7M), w3-p110 (P1.10, 6M), w3-p114 (P1.14, 5M), w3-p116 (P1.16, 7M), w3-p117 (P1.17, 7M) |
| ~19:30 | Wave 3 | Complete | 32/32 MEDIUMs resolved. P1.7: binary gate explicit, lsp_diagnostics schema, gate intercept point, waiver-path DoD, exit_class cross-cut, DiagItem format, perf DoD. P1.10: clean-halt defined, decidedAt clarified, inline keyboard API, status transitions aligned, 409 non-paused guard, bot registration DoD. P1.14: zero-inference testable, Zod schema, citation caveat, alias alignment, 11-field DoD. P1.16: hop-result shape, P1.3 transitive verified, citation caveat, INV-3 future-proofed, §13 mapping cited, latency DoD, epic=root-issue clarified. P1.17: idempotency note, evidenceRef format, merge-order constraint, sample-repo guard, originKind literal, citation caveat, schema-validation DoD. |
| ~19:35 | Wave 4 | Dispatching | Single bundled subagent for all 17 LOWs across 5 stories |
| ~19:40 | Wave 4 | Complete | 17/17 LOWs resolved. P1.7: citation caveat, zero-files DoD, SP estimate note, LSP cold-start note. P1.10: FR validity confirmed, OQ-3 context clarified. P1.14: SP estimate note, citation caveat verified (W3), zero cost_events DoD. P1.16: FR-OR-7 clarified, Archon residual verified clean (W0), --issue DoD, exit_class ack. P1.17: citation caveat, P1.18/19 exclusion DoD, SP estimate note, gate report persistence. 2 of 17 LOWs pre-resolved by prior waves (P1.14-L2, P1.16-L2). |
| ~19:50 | Wave 5 | Dispatching | 5 parallel fresh-eyes verifiers spawned (sonnet model for context-window safety) |
| ~19:55 | Wave 5 | Complete | 124 new findings across 5 stories: P1.7=25 (0B/5H/13M/7L), P1.10=23 (3B/5H/8M/7L), P1.14=24 (3B/7H/7M/7L), P1.16=27 (2B/6H/13M/6L), P1.17=25 (2B/7H/10M/6L). Dominant finding classes: schema-gap, missing-guard, cross-cut-consistency, contract-mismatch. 10 BLOCKERs + 30 HIGHs = 40 items for W5b. 51 MEDIUMs + 33 LOWs = 84 items for W5c. |
| ~20:00 | Wave 5b | Dispatching | 5 parallel subagents for BLOCKER+HIGH re-fix (P1.7=5, P1.10=8, P1.14=10, P1.16=8, P1.17=9) |
| ~20:10 | Wave 5b | Complete | 40/40 B+H re-fixes resolved. P1.7: coms_await removed, errorCount unified, lsp_diagnostics cross-ref, mixed gate test, symlink guard. P1.10: callback_data redesign (base64url <64B), webhook route POST /hermes/telegram/callback, decidedByUserId Paperclip resolution, dead P0.8 refs purged, TTL race resolved, rate-limit+replay, schema enumeration. P1.14: run_id z.string().min(1), exit_class added (12 fields), activity_log replaced with concrete tables, recordOutcome spec, terminal-status guard, storage unified to usageJson.outcomeRecord, runId→issueId join, AC-3 scoped to P1.14, per_role_model_tier reads router, rationale DoD test. P1.16: Hop 9 TDI aligned, Hop 10 bank={repo}, AC-2 dual budget, companyId scoping hops 2-7, FR-OR-7 parenthetical removed, Hop 8 corrected, --issue test DoD, exit_class in report. P1.17: cost-summary route corrected, clause 6 ownership clarified, WarrenClient SSE corrected, exit_class+prRef in schema, idempotency spec, bank derivation from QDS_SAMPLE_REPO, TELEGRAM_MOCK_MODE=gate, forced-failure clauses 4/5, P1.14 predecessor clarified. |
| ~20:15 | Wave 5c | Dispatching | 5 parallel subagents for MEDIUM+LOW re-fix (P1.7=19, P1.10=15, P1.14=14, P1.16=19, P1.17=16) |
| ~20:45 | Wave 5c | Complete | 84/84 M+L re-fixes resolved. P1.7(19): severity enum, lsp_diagnostics disambiguation, INV-4 cleanup, waiver idempotency, AC-1 errorCount, malformed JSON test, SUM verification, INV-2 prefix, partial field, changed_files cap, waiver enum extensibility, AC-2 waivers test, --mode test, truncated NDJSON, path unification, dedup test, waiver reason, stderr format, SP note. P1.10(15): WarrenClient resume path, non-paused guard, AC-2 sub-conditions, DoD reorganization, env var enumeration, telegram_plugin deferred, CLI local_trusted, RESUMABLE clarification, temporal AC-3 bound, backward-compat test, notifyChannel CLI, concurrent pauses test, health-check handler, wiring-closed sub-headings, timeoutMs priority. P1.14(14): 30s timeout guard, cost_data_available disambiguation, retry/exit naming, runId query DoD, retry cost aggregation, heartbeatRunId discovery SQL, archetype P1.5 ref, integer cost_cents, FR-MG-9 spec ref, router-rationale-store removed, Zod schema DoD, per_role_model_tier aggregation test, 600ms budget, orphan run guard. P1.16(19): AC-3 issueId-scoped cost_events, hop-level report fields, Hop 1 lookup mechanism, per-hop perf DoD, empty .seeds guard, agents.reportsTo deferred, P1.10 table refs, budgetMonthlyCents unified, multi-PR ambiguity, epic root DoD, cycle detection note, NFR-ACC-1 scope, Hop 7 fs.readFile, 1-based numbering, backward-compat test, CLI output format, 3s per-hop timeout, concurrent walk safety, executionPolicy blob clarification. P1.17(16): clause 1 unconditional check, per-clause timeout, gate report persistence DoD, sequential clause ordering, missing sample-repo fast-fail, durationMs default(0), INV-3 $QDS_COMPANY_ID, Warren workflow name validation, clause 8 gateway-only, retryCount<8 sub-check, SP rewrite, stdout clean JSON DoD, P1.16 merge-order DoD, multi-clause exit code, cost boundary note, issue-create route cited. |
| ~20:45 | Campaign | ✅ COMPLETE | Round 4 finished. 84 original findings + 124 W5 verification findings = 208 total. All resolved across 5 stories. Zero regressions on verified-correct elements. |
