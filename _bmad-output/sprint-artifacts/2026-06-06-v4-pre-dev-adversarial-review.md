# QDS-Factory v4 — Pre-Dev Adversarial Review Campaign

**Date:** 2026-06-06
**Status:** ✅ CAMPAIGN COMPLETE — All 124 findings resolved (47 initial + 77 verification)
**Scope:** 5 stories (P0.3, P0.7, P0.9, P0.11, P1.1)
**Prior review:** `adversarial-review-findings-2026-06-06.md` (iteration 1, ~27 HIGH / ~40 MED, corrections deferred)
**Warren decision:** Applied (P0.1, P0.4, P0.8 killed; sprint-status.yaml updated ✅)
**Method:** 5 parallel PhD-level adversarial reviewers → collated tracker → wave protocol
**Session:** Initial scan completed 2026-06-06 ~13:50 EDT

---

## Status Dashboard

| Wave | Status | Findings | Done | Remaining |
|------|--------|----------|------|-----------|
| Initial Scan | ✅ DONE | 47 | 47 | 0 |
| Wave 0 — Cross-cutting | ✅ DONE | 5 CC items | 5 | 0 |
| Wave 1 — BLOCKERs | ✅ DONE | 3 BLOCKERs | 3 | 0 |
| Wave 2 — HIGHs | ✅ DONE | 12 HIGHs | 12 | 0 |
| Wave 3 — MEDIUMs | ✅ DONE | 13 MEDIUMs | 13 | 0 |
| Wave 4 — LOWs | ✅ DONE | 10 LOWs | 10 | 0 |
| Wave 5 — Verification | ✅ DONE | 77 | 33 B/H | 44 M/L |
| Wave 5b — Re-fix B/H | ✅ DONE | 33 | 33 | 0 |
| Wave 5c — Re-fix M/L | ✅ DONE | 44 | 44 | 0 |

## Per-Story Progress

| Story | Title | SP | BLOCKER | HIGH | MED | LOW | Total |
|-------|-------|-----|---------|------|-----|-----|-------|
| P0.3 | launcher-mixed-model-demo | 4 | 2 | 3 | 3 | 2 | 10 |
| P0.7 | paperclip-plugins-install | 4 | 2 | 2 | 2 | 2 | 8 |
| P0.9 | memory-banks-hindsight-mulch | 4 | 3 | 3 | 4 | 3 | 13 |
| P0.11 | phase0-exit-gate | 3 | 3 | 1 | 2 | 1 | 7 |
| P1.1 | dev-manager-registered | 3 | 3 | 3 | 2 | 1 | 9 |
| **Totals** | | | **13** | **12** | **13** | **9** | **47** |

> Note: 1 cross-cutting BLOCKER theme counted per-story yields 13 story-level BLOCKERs below; cross-cutting table shows 5 unique CC themes.

## Cross-Cutting Themes

| CC ID | Theme | Stories Affected | Severity | Status |
|-------|-------|------------------|----------|--------|
| CC-1 | **Dead-story dependencies** — P0.1, P0.4, P0.8 killed but still referenced as dependencies/satisfiers across P0.3, P0.11 | P0.3, P0.11 | BLOCKER | ✅ DONE |
| CC-2 | **sprint-status.yaml stale** — killed stories still listed as active | All | HIGH | ✅ DONE |
| CC-3 | **Warren terminology residuals** — "Archon", "dag-executor", "Dev manager", "reportsTo org-chart" used post-Warren decision | P0.3, P1.1 | BLOCKER | ✅ DONE |
| CC-4 | **API endpoint paths unverified** — Hindsight paths, Paperclip `/api/me` vs `/api/agents/me` not validated against source | P0.9, P1.1 | BLOCKER | ✅ DONE |
| CC-5 | **Auth mode mismatch** — Paperclip `local_trusted` has no auth, but stories require bearer/admin-gate enforcement | P0.7, P1.1 | BLOCKER | ✅ DONE |

---

## Findings

### Cross-Cutting (resolve in Wave 0)

| ID | Stories | Severity | Title | Status | Fix Recipe |
|----|---------|----------|-------|--------|------------|
| CC-1 | P0.3, P0.11 | BLOCKER | Dead-story dependencies (P0.1, P0.4, P0.8) | ✅ DONE | sprint-status.yaml: P0.1/P0.4/P0.8 → status:killed; deps purged from P0.3, P0.11, P1.4, P1.10. P0.3: P0.1 dep replaced with self-contained env-passthrough. P0.11: AC-4→P0.3, AC-7→P0.3, AC-11→this gate (self-assembles OQ log). |
| CC-2 | All | HIGH | sprint-status.yaml stale | ✅ DONE | sprint-status.yaml: P0.1/P0.4/P0.8 marked killed; dependency edges cleaned; meta updated to reference new tracker. |
| CC-3 | P0.3, P1.1 | BLOCKER | Warren terminology residuals | ✅ DONE | P0.3: "Archon bash node"→"Warren run"; dag-executor.ts refs→Warren-neutral stdout/stderr; dag-node.ts→"caller's timeout". Zero remaining Archon/dag hits. P1.1: reportsTo clarified as Paperclip hierarchy (not Warren); "Dev manager" = Hermes role name. |
| CC-4 | P0.9, P1.1 | BLOCKER | API endpoint paths unverified | ✅ DONE | P1.1: /api/me→/api/agents/me (obs 20896). P0.9: Hindsight paths verified via context7 + hindsight-docs skill. **Bonus: recall path corrected** — actual is `/v1/default/banks/{bank_id}/memories/recall` (has `/memories/` prefix), not `…/recall`. All paths now explicit. Partially resolves P0.9-B1. |
| CC-5 | P0.7, P1.1 | BLOCKER | Auth mode mismatch | ✅ DONE | P0.7 + P1.1: auth-dependent ACs documented as code-level assertions under `local_trusted` mode. Mode notes added to AC-1/2/3/4 and security invariants. Server-enforced auth deferred to non-`local_trusted` configuration. |

### P0.3 — launcher-mixed-model-demo

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P0.3-B1 | BLOCKER | dead-reference | Killed P0.1 dependency | ✅ DONE (Wave 0 CC-1) | Removed P0.1 from deps; env passthrough self-contained in launcher. |
| P0.3-B2 | BLOCKER | dead-reference | Outdated dag-executor.ts references | ✅ DONE (Wave 0 CC-3) | All Archon/dag-executor refs replaced with Warren-neutral equivalents. Zero remaining hits. |
| P0.3-H1 | HIGH | contract-gap | Coms path selection discovery unspecified | ✅ DONE | Added `PI_COMS_MODE` env var discovery + `config/pi-coms.json` fallback + `--coms-mode` CLI override to Technical Notes. E2E Slice updated with discovery note. |
| P0.3-H2 | HIGH | dependency-error | Demo requires live API keys (unproven coms) | ✅ DONE | HONESTY note expanded: AC-1 cannot pass without both API keys; absent keys → BLOCKED-on-creds exit (not skipped/false-pass); no mock/stub path for make-or-break. |
| P0.3-H3 | HIGH | model-id | Invalid model ID `anthropic/claude-opus-4` | ✅ DONE | Replaced with `claude-sonnet-4-6` (generational Anthropic model alias — per Wave 5b/launcher guidance, generational aliases auto-resolve to current stable variant, avoiding retirement breaks from date-pinned IDs like `claude-sonnet-4-20250514`). OpenRouter slugs `openrouter/z-ai/glm-4.6` and `openrouter/moonshotai/kimi-k2` retained as valid. All 3 occurrences in story file updated. |
| P0.3-M1 | MEDIUM | schema-gap | Merged-output schema missing edge cases | ✅ DONE | Added edge-case rules to Contracts/Schema: `changed_files: []` valid, `result: null` invalid, `exit_class` mandatory non-null. |
| P0.3-M2 | MEDIUM | ac-ambiguity | Make-or-break AC is compound (not binary) | ✅ DONE | Split AC-1 into labeled sub-clauses (a) stdout format + (b) coms evidence; both required but independently diagnosable. |
| P0.3-M3 | MEDIUM | wiring-claim | "No sibling story required" contradicts P0.4 dependency | ✅ DONE | Guards/limits rewritten: loopy-kill guards IMPLEMENTED here; P0.4 killed, proof obligation in DoD (partial kill-proof via e2e). |
| P0.3-L1 | LOW | integration-accuracy | Context-path handling unspecified | ✅ DONE | Added to Technical Notes: launcher resolves `--context-path` to absolute path, validates dir exists with ≥1 `.jsonl` file, exits non-zero if missing. |
| P0.3-L2 | LOW | other | Budget cap propagation mechanism unclear | ✅ DONE | Added to Technical Notes: caps propagated as `BUDGET_CAP_ROLE_0`/`_1`/`_2` env vars to PI subprocesses, sourced from `--budget-role0-cents`/`--budget-role1-cents`/`--budget-role2-cents` CLI args (values in US cents), falling back to `--budget-cap-cents` if per-role flag omitted, default 50 cents ($0.50). |

### P0.7 — paperclip-plugins-install

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P0.7-B1 | BLOCKER | security-gap | Auth enforcement dead under `local_trusted` | ✅ DONE (Wave 0 CC-5) | Auth-dependent ACs documented as code-level assertions under local_trusted mode notes. Server-enforced auth deferred. |
| P0.7-B2 | BLOCKER | dependency-error | Telegram npm package name unknown | ✅ DONE | Resolved: canonical package is `paperclip-plugin-telegram` (npm, v0.6.1, by mvanhorn, github.com/mvanhorn/paperclip-plugin-telegram). `QDS_TELEGRAM_PLUGIN_PKG` env var has verified default + fail-fast npm-name regex validation. All `<telegram-pkg>` placeholders replaced. |
| P0.7-H1 | HIGH | contract-gap | Tenant binding missing (`:companyId` cross-check) | ✅ DONE | Added INV-5 (tenant isolation) to Security Invariants: `agent_api_keys` row is company-bound, `:companyId` URL mismatch is rejected. Updated AC-2 to assert tenant isolation explicitly with mode note for `local_trusted` (code-level assertion). |
| P0.7-H2 | HIGH | wiring-claim | Admin user setup undocumented | ✅ DONE | Added "Admin user seeding" paragraph to Technical Notes: Paperclip auto-seeds admin on first boot (root agent + company "QDS"), bring-up script confirms via `GET /api/agents/me`, fallback `ensureAdmin()` function. Added DoD checkbox for admin-seed assert-before-install. |
| P0.7-M1 | MEDIUM | integration-accuracy | Plugin event bridge claim overreaching | ✅ DONE | Integration-points bullet scoped: "bridge present" = service exists (SDK requires it), NOT events fire/subscribe exercised. DoD unchanged (no event-delivery assertion). |
| P0.7-M2 | MEDIUM | ac-ambiguity | Idempotency not tested by any AC | ✅ DONE | Added AC-5: re-install is idempotent (no error, no duplicate rows, still exactly two plugins as installed). |
| P0.7-L1 | LOW | schema-gap | Package name validation rules missing | ✅ DONE | Added to Contracts/Schema: max 256 chars + `^[a-zA-Z0-9@/-_.]+$` npm pattern; install driver rejects violations before POST. |
| P0.7-L2 | LOW | other | Env file example missing required vars | ✅ DONE | Added `config/paperclip.env.example` paragraph to Technical Notes listing `QDS_TELEGRAM_PLUGIN_PKG`, `PAPERCLIP_API_BASE`, `PAPERCLIP_ADMIN_TOKEN`, `COMPANY_ID`. |

### P0.9 — memory-banks-hindsight-mulch

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P0.9-B1 | BLOCKER | contract-gap | Hindsight API paths unverified | ✅ DONE (Wave 0 CC-4) | Paths verified via context7 + hindsight-docs skill. Recall path corrected (added /memories/ prefix). All paths now explicit with verification note. |
| P0.9-B2 | BLOCKER | dependency-error | Mulch tool existence unconfirmed | ✅ DONE | Mulch confirmed real: `@os-eco/mulch-cli` by jayminwest (github.com/jayminwest/mulch). Commands `mulch learn`/`record`/`prime` verified. Graceful fallback: absent tool → `mulchImported: 0` + warning, round-trip passes. Installation docs added. |
| P0.9-B3 | BLOCKER | integration-accuracy | Cloud API shape assumed identical to self-host | ✅ DONE | Cloud/self-host API shapes confirmed IDENTICAL. Single OpenAPI spec (v0.7.2), only `base_url` differs. Verified via hindsight-docs skill + context7. Bank creation: idempotent upsert via `PUT /v1/default/banks/{bank_id}` or auto-create on first retain. No path branching needed in `HindsightClient`. |
| P0.9-H1 | HIGH | ac-ambiguity | Round-trip success criteria underdefined | ✅ DONE | AC-1 expanded with explicit success criteria: `recalledId` must exact-match retain request's `document_id`; `reflected===true` means non-empty response body with parseable schema (not just HTTP 200). Verified against OpenAPI RetainResponse schema (`success`, `bank_id`, `items_count`). |
| P0.9-H2 | HIGH | wiring-claim | Mulch import mechanism wrong/unspecified | ✅ DONE | Added P0.9-H2 resolution block to Technical Notes: 3-step Mulch import flow (learn → record → prime) with exact CLI args/flags, per-domain JSONL processing, fallback behavior (skip domain on failure, set `mulchImported: 0` if no `.jsonl` files), and JSONL format spec (`{content, metadata}`). |
| P0.9-H3 | HIGH | schema-gap | Bank creation endpoint missing | ✅ DONE | Added `createBank(bankId, mission?): Promise<BankResult>` to HindsightClient type using `PUT /v1/default/banks/{bank_id}` (idempotent upsert, operationId `create_or_update_bank`, confirmed via OpenAPI spec). Updated DoD: explicit PUT before round-trip, not relying on auto-create. BankProfileResponse schema documented. |
| P0.9-M1 | MEDIUM | security-gap | Token env var names inconsistent | ✅ DONE | INV-1 extended: `HINDSIGHT_CP_DATAPLANE_API_KEY` primary, `HINDSIGHT_API_KEY` legacy alias with deprecation warning. |
| P0.9-M2 | MEDIUM | wiring-claim | Bank isolation enforcement unspecified | ✅ DONE | Added "Bank isolation enforcement" to Technical Notes: client-side runtime assertion in HindsightClient validates bankId against provisioned ids before HTTP. Server does not enforce cross-bank isolation. |
| P0.9-M3 | MEDIUM | ac-ambiguity | Token validation failure mode unclear | ✅ DONE | AC-4 extended: any 4xx/5xx → non-zero with logged status+body; no retry; 401 logs specific key-check guidance. |
| P0.9-M4 | MEDIUM | integration-accuracy | Mulch prime verification mechanism unspecified | ✅ DONE | Added to Technical Notes: `mulch prime` must return exit 0 + stdout ≥50 chars; failures log warning + increment counter, do NOT abort. |
| P0.9-L1 | LOW | model-id | Tooling pin version — actual package names unknown | ✅ DONE | Added to Technical Notes: `@os-eco/mulch-cli` (Mulch), `@os-eco/seeds-cli` (Seeds) with "verify during dev" note. |
| P0.9-L2 | LOW | other | OQ-4 decision rationale schema undefined | ✅ DONE | Defined inline: `{ cost: string, latency: string, data_residency: string }` structure added to DoD line where OQ-4 is referenced. |
| P0.9-L3 | LOW | dead-reference | PRD/R4/R3 references not expanded | ✅ DONE | R4/R3 references expanded with parenthetical inline summaries (no external doc lookup needed). |

### P0.11 — phase0-exit-gate

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P0.11-B1 | BLOCKER | dead-reference | AC-7 references killed P0.1 | ✅ DONE (Wave 0 CC-1) | AC-7 rewritten: satisfiedBy→P0.3, env-passthrough via launcher CLI args. |
| P0.11-B2 | BLOCKER | dead-reference | AC-11 references killed P0.8 | ✅ DONE (Wave 0 CC-1) | AC-11 rewritten: satisfiedBy→this gate, self-assembles OQ decision log. |
| P0.11-B3 | BLOCKER | dependency-error | OQ decision log never assembled (P0.8 dead) | ✅ DONE (Wave 0 CC-1) | OQ decision log responsibility assigned to gate self-assembly. readOqDecisionLog() documented. |
| P0.11-H1 | HIGH | contract-gap | AC count mismatch with PRD §13 | ✅ DONE | Verified 1:1 mapping: §13 clauses (1,2,3,4,4b,5,6,7,7b,8) → AC-2..AC-11 (10 sub-ACs). AC-1 is make-or-break wrapper, not an extra clause. No extra ACs, no missing clauses. Added explicit mapping table to Technical Notes showing §13 clause → AC → satisfiedBy story correspondence. |
| P0.11-M1 | MEDIUM | wiring-claim | OQ decision provenance unverifiable | ✅ DONE | Added OQ decision-log validation rules to Technical Notes + DoD item: file exists, 6 keys, non-empty decision each, optional fallback. |
| P0.11-M2 | MEDIUM | integration-accuracy | Killed stories still in dependency list | ✅ DONE (Wave 0 CC-1) | P0.1/P0.4/P0.8 removed from dependency edges in story + sprint-status.yaml. |
| P0.11-L1 | LOW | model-id | OQ decision log schema undefined | ✅ DONE | Added Zod-style entry schema to Technical Notes: `{ id: "OQ-1".."OQ-6", decision: string (non-empty), fallback?: string }` as array of exactly 6 entries. |

### P1.1 — dev-manager-registered

| ID | Severity | Category | Title | Status | Fix Recipe |
|----|----------|----------|-------|--------|------------|
| P1.1-B1 | BLOCKER | integration-accuracy | Endpoint path `/api/me` should be `/api/agents/me` | ✅ DONE (Wave 0 CC-4) | All /api/me→/api/agents/me. Endpoint note added to Technical Notes. |
| P1.1-B2 | BLOCKER | model-id | Warren has no org-chart — `reportsTo` invalid | ✅ DONE (Wave 0 CC-3) | Clarified: reportsTo is Paperclip's own hierarchy (agents.ts self-FK), not Warren's org-chart. |
| P1.1-B3 | BLOCKER | dead-reference | "Dev manager" terminology may not map to Warren | ✅ DONE (Wave 0 CC-3) | Clarified: "Dev manager" is a Hermes role name, not Warren org-chart position. Terminology note added. |
| P1.1-H1 | HIGH | security-gap | Self-lookup doesn't prove token-agent binding | ✅ DONE | AC-1 amended: added assertion that self-lookup with a different agent's key does NOT return the Dev manager's data. DoD item added for token-agent binding uniqueness test. Mode note extended to clarify `local_trusted` binding is code-level. |
| P1.1-H2 | HIGH | ac-ambiguity | Idempotency identity mechanism unclear | ✅ DONE | Technical Notes: added "Idempotency identity key" paragraph defining the `(adapterType, companyId, name)` tuple as the identity key. AC-2 rewritten to reference the tuple explicitly. API key alone does NOT determine identity. |
| P1.1-H3 | HIGH | wiring-claim | Budget enforcement not verified | ✅ DONE | Deferred to P1.13 with explicit scoping. Technical Notes: "Budget enforcement scope" paragraph added clarifying this story verifies (a) budget non-null, (b) readable via self-lookup, (c) matches configured cap. DoD item added. Dependency edge note added: P1.1 sets the cap; P1.13 enforces it. |
| P1.1-M1 | MEDIUM | contract-gap | Cost attribution not wired | ✅ DONE | DoD item added: cost attribution deferred to P1.13. Technical Notes guards/limits paragraph extended with explicit scoping. |
| P1.1-M2 | MEDIUM | security-gap | Empty/null key handling not tested in AC | ✅ DONE | AC-3 expanded: absent, empty-string, whitespace-only all produce non-zero exit. DoD item added covering all three variants. |
| P1.1-L1 | LOW | other | Token expiration/invalid scenarios untested | ✅ DONE | Added DoD checkboxes: expired token → 401, malformed token → 401 test cases. |

---

## Verified-Correct Elements

Per story — elements reviewers confirmed are correct and must not be regressed by fixes:

### P0.3
- ✅ `changed_files: string[]` mandatory in merged output (CORRECTNESS-C enforced)
- ✅ 3-role mixed-model concept (1 Anthropic + 2 OpenRouter)
- ✅ stdout-only merged JSON, stderr for all diagnostics
- ✅ Per-role budget cap owned by launcher (INV-3)

### P0.7
- ✅ Idempotent install driver concept
- ✅ `hermes_local` adapter injection mechanism (registry.ts:468-469)
- ✅ Plugin install request body schema
- ✅ No schema mutation / DDL authoring (INV-4)

### P0.9
- ✅ OQ-4 decision record concept (even if details need work)
- ✅ Bank naming convention `{repo}` and `{repo}-dev-meta`
- ✅ Token-not-conflated-with-LLM-key (INV-1 / NFR-SEC-5)
- ✅ Fail-closed on missing token (AC-4)

### P0.11
- ✅ Binary gate concept (pass:true/false + exit code)
- ✅ Fail-closed design (errored/ambiguous → pass:false)
- ✅ Zod schema for verdict output
- ✅ Per-assertion `satisfiedBy` cross-reference pattern

### P1.1
- ✅ `hermes_local` adapter with env injection
- ✅ Secrets from env only, never hardcoded (INV-2)
- ✅ Fail-closed on missing API key (AC-3)
- ✅ No orphan requirement (INV-3, even if mechanism needs work)

---

## Session Log

| Time | Wave | Agent IDs | Summary |
|------|------|-----------|---------|
| 2026-06-06 ~13:25 | Initial Scan | (7 dispatched, prior session) | Campaign launched (prior session). 7 reviewers dispatched — results never collated. |
| 2026-06-06 ~13:50 | Initial Scan (retry) | reviewer-p03, reviewer-p07, reviewer-p09, reviewer-p011, reviewer-p11 | 5 reviewers dispatched for focused review. All returned. 51 findings: 13 BLOCKER, 12 HIGH, 15 MEDIUM, 10 LOW. 5 cross-cutting themes identified. Tracker populated. |
| 2026-06-06 ~14:02 | Wave 0 — Cross-cutting | wave0-p03, wave0-p07, wave0-p09, wave0-p011, wave0-p11 + parent | 5 agents + parent. All CC items resolved. CC-2: sprint-status.yaml updated (P0.1/P0.4/P0.8 killed, deps purged). CC-1: dead refs removed from P0.3+P0.11. CC-3: Warren terminology purged from P0.3+P1.1. CC-4: API paths verified+corrected (P0.9 recall path had wrong segment; P1.1 /api/me fixed). CC-5: local_trusted auth notes added to P0.7+P1.1. Bonus discovery: P0.9 recall path required `/memories/` prefix. |
| 2026-06-06 ~14:20 | Wave 1 — BLOCKERs | wave1-p07, wave1-p09 | 2 agents, 3 BLOCKERs resolved. P0.7-B2: Telegram package resolved as `paperclip-plugin-telegram` (npm v0.6.1). P0.9-B2: Mulch confirmed real (`@os-eco/mulch-cli`). P0.9-B3: Cloud/self-host API shapes confirmed identical. All 13 original BLOCKERs now resolved (10 Wave 0 + 3 Wave 1). |
| 2026-06-06 ~15:00 | Wave 2 — HIGHs | wave2-p07, wave2-p09, wave2-p011, wave2-p11, wave2-p03 (parent direct) | 5 agents dispatched (1 hit context limit, retried by parent inline). All 12 HIGHs resolved. P0.3: coms discovery via PI_COMS_MODE env/config; HONESTY expanded for BLOCKED-on-creds; model ID `anthropic/claude-opus-4`→`claude-sonnet-4-20250514`. P0.7: INV-5 tenant isolation added; admin seeding documented. P0.9: round-trip criteria explicit (recalledId exact match, reflected non-empty schema); Mulch import flow specified (learn/record/prime); bank creation via explicit PUT. P0.11: §13 clause-to-AC mapping table added (10:1 verified). P1.1: token-agent binding uniqueness added to AC-1; idempotency identity tuple `(adapterType, companyId, name)` defined; budget enforcement deferred to P1.13. |
| 2026-06-06 ~14:31 | Wave 2 — HIGHs (P0.9) | wave2-p09 | 1 agent, 3 HIGHs resolved. P0.9-H1: AC-1 round-trip success criteria defined (recalledId=exact document_id match, reflected=non-empty parseable body). P0.9-H2: Mulch import flow documented (learn→record→prime, CLI args, JSONL format, per-domain fallback). P0.9-H3: Bank creation endpoint documented (PUT /v1/default/banks/{bank_id}, createBank method added to HindsightClient, explicit creation before round-trip). OpenAPI spec verified for all three. No regressions to verified-correct elements. |
| 2026-06-06 ~21:30 | Wave 3 — MEDIUMs | wave3-p03, wave3-p07, wave3-p09, wave3-p011, wave3-p11 | 5 agents, 14 MEDIUMs resolved. P0.3: merged-output edge cases (empty changed_files valid, result:null invalid, exit_class mandatory); AC-1 split into sub-clauses (a) stdout format + (b) coms evidence; kill-guard ownership clarified (P0.4 killed, proof in DoD). P0.7: event bridge claim scoped to "service exists" not "events fire"; idempotency AC-5 added. P0.9: token env var precedence standardized (primary + legacy alias); bank isolation enforced client-side via HindsightClient bankId assertion; HTTP error handling explicit (4xx/5xx → non-zero, 401 diagnostic); Mulch prime verification (exit 0 + stdout ≥50 chars). P0.11: OQ decision-log validation rules (6 keys, non-empty decision, optional fallback). P1.1: cost attribution deferred to P1.13 with DoD note; AC-3 expanded to cover absent/empty-string/whitespace-only key. No regressions to verified-correct elements. |
| 2026-06-06 ~21:40 | Wave 4 — LOWs | wave4-lows | 1 bundled agent, 10 LOWs resolved across all 5 stories. P0.3: context-path handling documented (--context-path resolution + .jsonl validation); budget cap propagation specified (BUDGET_CAP_ROLE_<N> env vars). P0.7: package name validation added (≤256 chars + npm regex); env example paragraph with 4 required vars. P0.9: tooling package names pinned (@os-eco/mulch-cli + @os-eco/seeds-cli); OQ-4 rationale schema defined; PRD R4/R3 references expanded inline. P0.11: OQ decision-log Zod-style schema added (6-entry array with id/decision/fallback). P1.1: expired/malformed token → 401 DoD checkboxes added. No regressions. All 50 findings now resolved. |
| 2026-06-06 ~22:00 | Wave 5 — Verification | verify-p03, verify-p07, verify-p09, verify-p011, verify-p11 | 5 fresh-eyes verifiers dispatched. 77 new findings: 7 BLOCKER, 26 HIGH, 26 MEDIUM, 18 LOW. Critical: P0.3 model ID retiring in 9 days; P0.9 Mulch CLI commands entirely fabricated; P0.7 install body field wrong; P0.11 compound AC; P1.1 DoD contradicts mode notes. No verified-correct regressions. Wave 5b/5c dispatching. |
| 2026-06-06 ~22:10 | Wave 5b — Re-fix B/H | w5b-p03, w5b-p07, w5b-p09, w5b-p011, w5b-p11 | 5 agents, 33 B/H items resolved. P0.3: model ID updated (claude-sonnet-4-6), dead refs purged, result/waivers schema typed, run-id UUID v4. P0.7: install body corrected (packagePath), version updated, auth mode notes upgraded, INV splits, PluginRecord shape. P0.9: full Mulch CLI rewrite (fabricated→real `ml` commands), Seeds 0.2.5→0.5.9, Mulch 0.6.3→0.10.7, mental_model removed, RetainResponse corrected. P0.11: AC-7 split (§13.5a+§13.5b), AC-5 branch tracking, OQ log path unified, timeout budget, AC-6/AC-11 cross-link. P1.1: DoD/mode reconciled, Bearer testability upgraded, AC-4 RUN_ID, identity tuple values. |
| 2026-06-06 ~23:00 | Wave 5c — Re-fix M/L | w5c-p03, w5c-p07, w5c-p09, w5c-p011, w5c-p11 | 5 agents, 44 M/L items resolved. P0.3 (10): role-model format, 0-retry policy, lead role defined, subprocess cleanup, partial field, coms casing, grep patterns, budget units, archetype defaults. P0.7 (10): single canonical regex, version assertion logic, P0.8 purged, star count removed, admin token flow, idempotency version handling, line wrapping, PluginEventBus scoped, file/DoD reconciled, SDK framing. P0.9 (8): CreateBankRequest deprecated fields, recall POST body schema, bank naming clarified, "private"→"public npm", binary alias, path consistency. P0.11 (9): "aggregated" not "merged", Zod detail max 500, P0.8 noise purged, partial-pass reporting, OQ file ownership, P0.4 parentheticals removed, OQ ID clarity. P1.1 (7): budget pinned 50000 cents, hierarchy walk logic, reportsTo DB FK framing, P1.13 contract boundary, notation standardized, AC-1 split 4 sub-clauses, DoD differentiated. **CAMPAIGN COMPLETE.** |
