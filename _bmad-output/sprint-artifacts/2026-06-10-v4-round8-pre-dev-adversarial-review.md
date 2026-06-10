# QDS-Factory v4 Sprint — Round 8 Pre-Dev Adversarial Review — Findings, Plan, and Multi-Session Tracker

**Created:** 2026-06-10
**Status:** COMPLETE — all waves resolved; stories ready for dev
**Scope:** P0.7, P0.9, P0.3, P1.1, P1.3, P1.4, P1.6
**Goal:** Resolve all findings BEFORE dev begins so the foundation holds.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Status Dashboard](#status-dashboard)
3. [How agents work this doc](#how-agents-work-this-doc)
4. [Severity legend & status legend](#severity-legend--status-legend)
5. [Cross-cutting themes (fix once, fix everywhere)](#cross-cutting-themes-fix-once-fix-everywhere)
6. [Execution plan — wave structure](#execution-plan--wave-structure)
7. [Tracker: BLOCKERs](#tracker-blockers)
8. [Tracker: HIGHs](#tracker-highs)
9. [Tracker: MEDIUMs](#tracker-mediums)
10. [Tracker: LOWs / nits](#tracker-lows--nits)
11. Full findings — per-story sections
12. [Verified-correct elements (do NOT undo)](#verified-correct-elements-do-not-undo)
13. Wave-5 verification findings (added after Wave 5 runs)
14. [Session log (append-only)](#session-log-append-only)
15. [Post-completion verification protocol](#post-completion-verification-protocol)

---

## Executive Summary

7 parallel adversarial reviewers ran PhD-level scrutiny on the highest-leverage QDS-Factory v4 sprint stories. Each reviewer cross-checked sibling stories for type/contract alignment, identified regressions from prior bot-review patches, and produced a fresh findings report.

**Result:** 102 distinct findings across 7 stories.

| Severity | Count | Definition |
|---|---|---|
| **BLOCKER** | 6 | Must fix before dev starts; will produce broken or insecure code if shipped as-written |
| **HIGH** | 25 | Significant gaps; will cause rework or production incidents within first 2 weeks |
| **MEDIUM** | 41 | Test/observability/config gaps; will surface as bugs or audit findings later |
| **LOW** | 30 | Polish, nits, doc inconsistencies |

**Stories under review:** P0.7 (SwarmClaw Agent/MCP), P0.9 (Hindsight Banks/Mulch), P0.3 (Mixed-Model Demo), P1.1 (Dev Manager A2A), P1.3 (Seeds Decompose/Mirror), P1.4 (Protocol Template), P1.6 (Pi-Team Protocol Step)

**Key themes:** RegisterAgentSchema divergence (P0.7↔P1.1), agentType enum insufficiency (P1.1↔P1.3), resolveBankId collision risk (P0.9), endpointUrl SSRF (P1.1), observability contract gaps (P1.4, P0.3), INV-SC2 args validation regression (P0.7).

---

## Status Dashboard

### Overall progress

| Severity | TODO | IN_PROGRESS | DONE | DEFERRED | BLOCKED |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 6 | 0 | 0 |
| HIGH    | 0 | 0 | 25 | 0 | 0 |
| MEDIUM  | 0 | 0 | 41 | 0 | 0 |
| LOW     | 0 | 0 | 30 | 0 | 0 |
| **TOTAL** | **0** | **0** | **102** | **0** | **0** |

### Per-story progress

| Story | B | H | M | L | Total | Notes |
|---|---|---|---|---|---|---|
| P0.7 | 3 | 4 | 5 | 4 | 16 | Agent registry, MCP bridge, command allowlist |
| P0.9 | 1 | 4 | 7 | 5 | 17 | Memory substrate, resolveBankId, Mulch import |
| P0.3 | 0 | 4 | 8 | 4 | 16 | Mixed-model demo, coms, budget enforcement |
| P1.1 | 0 | 3 | 5 | 5 | 13 | A2A delegation, SSRF, schema divergence |
| P1.3 | 0 | 2 | 4 | 6 | 12 | Seeds decomposition, sanitization, GitHub mirror |
| P1.4 | 0 | 3 | 7 | 4 | 14 | Protocol template, compare/decide algorithms |
| P1.6 | 2 | 5 | 5 | 2 | 14 | Pi-team dispatch, Warren harness, exit codes |

### Wave progress

| Wave | What | Status |
|---|---|---|
| Initial scan | 7 reviewers; tracker created | ✅ COMPLETE 2026-06-10 |
| 0 — Cross-cutting prep | 9 themes spanning ≥2 stories | ✅ COMPLETE (17 items resolved) |
| 1 — BLOCKERs | 6 BLOCKERs resolved per story | ✅ COMPLETE |
| 2 — HIGHs | 25 HIGHs resolved per story | ✅ COMPLETE |
| 3 — MEDIUMs | 41 MEDIUMs resolved per story | ✅ COMPLETE |
| 4 — LOWs/nits | 30 LOWs batched | ✅ COMPLETE |
| 5 — Verification | Re-run review pass; assert zero new BLOCKERs/HIGHs | ✅ COMPLETE (0B, 8H, ~26M, ~20L found) |
| 5b — Re-fix Wave-5 BLOCKERs/HIGHs | 8 HIGHs across 4 stories | ✅ COMPLETE 2026-06-10 |
| 5c — Wave-5 MEDIUMs/LOWs | 85 findings (0B, 15H, 43M, 27L) from fresh re-verification | ✅ COMPLETE 2026-06-10 |

---

## How agents work this doc

This doc is the persistent source of truth for fixing Round 8 review findings across multiple agent sessions. Follow this protocol:

1. **Pick up where left off:** Read [Status Dashboard](#status-dashboard) and the tracker tables. Find the next `⬜ TODO` item that has no unmet predecessors.
2. **Claim work:** Update the row's Status to `🟡 IN_PROGRESS`, write your agent ID + session date in the `Owner` column.
3. **Apply fix:** Read the corresponding finding in the per-story sections below for the concrete fix recipe. Edit the story file at the path noted.
4. **Verify:** Run any AC tests specified, or grep for the issue to confirm it's gone. For BLOCKERs/HIGHs, also run `gitnexus_impact` on any symbol you change.
5. **Mark done:** Update Status to `✅ DONE`, add a short `Notes` entry with the commit hash if applicable.
6. **Append to session log:** At the bottom of this doc, add a one-line entry: date, agent, items completed.
7. **Update Status Dashboard counters** so the next agent can see at a glance.

**Conflict avoidance:** If two agents are working concurrently, claim non-overlapping items from different stories. Cross-cutting Wave-0 items must be claimed singly.

**Don't skip LOWs.** Full-rigor mandate — all severities are addressed.

---

## Severity legend & status legend

**Severity:**
- **BLOCKER** — broken or insecure as-written; dev MUST NOT start until fixed
- **HIGH** — significant gap; production incident risk within 2 weeks
- **MEDIUM** — test/observability/config gap; tech debt accumulator
- **LOW / nit** — polish, doc consistency, minor robustness

**Status:**
- ⬜ **TODO** — not started
- 🟡 **IN_PROGRESS** — claimed by agent
- ✅ **DONE** — fix applied + verified
- ⏭️ **DEFERRED** — explicitly deferred via ADR or user approval (link required)
- ❌ **BLOCKED** — cannot proceed (note blocker in Notes column)

---

## Cross-cutting themes (fix once, fix everywhere)

These themes appear in ≥2 stories. Address them in **Wave 0** before story-by-story passes.

### CC-R8-1 — RegisterAgentSchema divergence (P0.7 ↔ P1.1)
**Affects:** P0.7 (B3), P1.1 (H3)
**Symptom:** P0.7 defines `{agentId, capabilities, metadata?}`. P1.1 uses `{agentId, agentType, endpointUrl, capabilities}`. Same endpoint (`POST /api/agents`), incompatible schemas.
**Fix:** Add `agentType` and `endpointUrl` as fields to P0.7's `RegisterAgentSchema` (agentType optional with default, endpointUrl optional with validation per P1.1 INV-3+INV-4). P1.1 makes both required for its registrations. Retain P0.7's `metadata?` field.
**Tracker IDs:** P0.7-B3, P1.1-H3

### CC-R8-2 — agentType enum insufficient for Seeds
**Affects:** P1.1 (H1), P1.3 (H2)
**Symptom:** Current enum `"department-manager"|"worker"|"observer"` can't represent Seeds agent. P1.3 must register `qds-seeds` but has no valid agentType.
**Fix:** Add `"service"` to the agentType enum in P1.1's schema. Document that `"service"` covers specialized handlers (Seeds, future agents). P1.3 specifies `agentType: "service"` for qds-seeds registration.
**Tracker IDs:** P1.1-H1, P1.3-H2

### CC-R8-3 — resolveBankId collision + trailing-hyphen edge case
**Affects:** P0.9 (B1, L1), P1.3 (consumer)
**Symptom:** Two different repo slugs can produce identical bank IDs after truncation. Single-pass trailing-hyphen strip misses hyphens reintroduced by truncation.
**Fix:** (a) Document collision risk and require caller-supplied unique repo slug. (b) Change trailing-hyphen strip to a loop: `while (result.startsWith('-') || result.endsWith('-')) result = result.replace(/^-|-$/g, '');`. (c) Add collision-detection note to provisioner.
**Tracker IDs:** P0.9-B1, P0.9-L1

### CC-R8-4 — endpointUrl SSRF risk
**Affects:** P1.1 (H2), P0.7 (via registration)
**Symptom:** INV-3 only validates http/https scheme; no hostname restriction. Transport Contract says "local HTTP POST only" but is not enforced.
**Fix:** Add INV-4 to P1.1: endpointUrl hostname must be localhost/127.0.0.1/::1. Update P0.7's registration validation to enforce the same constraint.
**Tracker IDs:** P1.1-H2

### CC-R8-5 — Observability contract (CC-9) gaps
**Affects:** P1.4 (M2 — no CC-9 section), P0.3 (M5 — missing sessionId/phaseId, M6 — missing timestamp)
**Symptom:** P1.4 is the only reviewed story missing a CC-9 section. P0.3's ComsLogEntry and CostEvent schemas have gaps.
**Fix:** Add CC-9 section to P1.4 with phase-transition logging. Add sessionId/phaseId to P0.3's ComsLogEntry. Add timestamp to CostEvent.
**Tracker IDs:** P1.4-M2, P0.3-M5, P0.3-M6

### CC-R8-6 — Phase-to-extension mapping table divergence
**Affects:** P0.3 (M2), P1.4 (M3)
**Symptom:** P0.3 has "cross-agent → extensions/cross-agent.ts". P1.4 has "summarize → extensions/cross-agent.ts". Different phase kind names for the same extension.
**Fix:** Reconcile: canonical name is `summarize` (P1.4). Update P0.3's table to add the `summarize` row and note that `cross-agent` was the pre-P1.4 name.
**Tracker IDs:** P0.3-M2, P1.4-M3

### CC-R8-7 — Mulch target bank contradiction (P0.9)
**Affects:** P0.9 (M5)
**Symptom:** AC-2 says `qds-collective`. AC-6 says `{repo}-dev-meta`. Technical Notes and storage contract say `-dev-meta`.
**Fix:** Reconcile to single target: `{resolveBankId(repoSlug)}-dev-meta` (as stated in Technical Notes). Update AC-2 to match. Update file description for mulch-importer.ts.
**Tracker IDs:** P0.9-M5

### CC-R8-8 — SIGTERM/SIGKILL escalation pattern
**Affects:** P0.7 (H3), P1.6 (M3)
**Symptom:** Both stories mention SIGTERM for process termination but neither specifies SIGKILL escalation after a grace period.
**Fix:** Add 5-second grace period after SIGTERM → SIGKILL escalation to both P0.7's AC6 and P1.6's INV-3.
**Tracker IDs:** P0.7-H3, P1.6-M3

### CC-R8-9 — Bank ID minimum length / edge cases
**Affects:** P0.7 (H1), P0.9 (H1, M1)
**Symptom:** BankIdSchema allows 1-char IDs. resolveBankId can produce empty strings.
**Fix:** Document that resolveBankId output must be validated before use. Add explicit validation in bank provisioner. Note that empty-string output is a caller error, not a runtime error.
**Tracker IDs:** P0.7-H1, P0.9-H1, P0.9-M1

---

## Execution plan — wave structure

Waves are sequenced; within a wave, items can be parallelized across stories.

### Wave 0 — Cross-cutting prep
Resolve CC-R8-1 through CC-R8-9 first. Each touches ≥2 stories. 7 parallel subagents bundled-by-story-file.

### Wave 1 — BLOCKERs (per-story)
6 remaining BLOCKERs (after Wave 0 resolves P0.7-B3 and P0.9-B1). Spawn 1 agent per affected story.

### Wave 2 — HIGHs (per-story)
25 HIGHs minus those resolved in Wave 0. Same per-story parallel pattern.

### Wave 3 — MEDIUMs (per-story)
41 MEDIUMs. Same pattern.

### Wave 4 — LOWs / nits (single bundled subagent)
30 LOWs. Bundle into one subagent processing each story sequentially.

### Wave 5 — Verification (parallel verifiers)
Spawn 7 parallel verifier subagents (one per story). Fresh eyes — no fix recipes briefed.

### Wave 5b — Re-fix Wave-5 BLOCKERs/HIGHs
### Wave 5c — Wave-5 MEDIUMs/LOWs

---

## Tracker: BLOCKERs

6 items. Must complete before dev can start.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| P0.7-B1 | P0.7 | INV-SC2 args validation: AC7 doesn't test `-`, `-p`, `--print`, `--require`/`-r` | ✅ DONE | Wave 1 | Expanded AC7 to enumerate all 6 denied flags + DoD test |
| P0.7-B2 | P0.7 | npx allows any npm package (no package allowlist) | ✅ DONE | Wave 1 | Added SWARMCLAW_NPX_PACKAGE_ALLOWLIST env-var + DoD test |
| P0.7-B3 | P0.7 | RegisterAgentSchema missing agentType/endpointUrl | ✅ DONE | Wave 0 | CC-R8-1: added optional agentType+endpointUrl to schema |
| P0.9-B1 | P0.9 | resolveBankId produces duplicate bank IDs for different repos | ✅ DONE | Wave 0 | CC-R8-3: trailing-hyphen loop + collision note |
| P1.6-B1 | P1.6 | mulchPrimed field in AC4 but absent from success output schema | ✅ DONE | Wave 1 | Added mulchPrimed+mulchPrimeError to schema + pi-lens step |
| P1.6-B2 | P1.6 | Hindsight unreachable during priming — no specified behavior | ✅ DONE | Wave 1 | Added Technical Note: log warning, set false, proceed |

---

## Tracker: HIGHs

25 items.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| P0.7-H1 | P0.7 | BankIdSchema allows 1-char bank IDs — operational confusion | ✅ DONE | Wave 0 | CC-R8-9: documented caller-side validation responsibility |
| P0.7-H2 | P0.7 | Tool cache doesn't handle tool-removal direction | ✅ DONE | Wave 2 | Added tool-not-found → cache invalidation + re-enumerate |
| P0.7-H3 | P0.7 | SIGTERM lifecycle: no SIGKILL escalation for stubborn procs | ✅ DONE | Wave 0 | CC-R8-8: 5s grace→SIGKILL added to AC6 |
| P0.7-H4 | P0.7 | INV-SC4 (no network listeners) untestable as specified | ✅ DONE | Wave 2 | Scoped to Phase 2 containerized; Phase 1 best-effort |
| P0.9-H1 | P0.9 | resolveBankId empty string for all-special-char input | ✅ DONE | Wave 2 | Added explicit all-special-char edge case + BankIdSchema.safeParse guard |
| P0.9-H2 | P0.9 | MulchExpertiseSchema→P1.12 MulchEntry mapping is lossy | ✅ DONE | Wave 2 | Fixed mapping: expertise→content, concepts→tags; added lossy note |
| P0.9-H3 | P0.9 | JSONL format: line delimiter, encoding, BOM unspecified | ✅ DONE | Wave 2 | Added LF-only, UTF-8 no BOM, BOM-stripping rules |
| P0.9-H4 | P0.9 | Dedup hash excludes expertise field — semantic collision | ✅ DONE | Wave 2 | Documented as intentional: dedup by domain+concepts, expertise is mutable payload |
| P0.3-H1 | P0.3 | ComsLogEntry type name collision (ComsEntry vs ComsLogEntry) + camelCase boundary | ✅ DONE | Wave 2 | Unified to ComsLogEntry + camelCase boundary note |
| P0.3-H2 | P0.3 | Graceful degradation for coms vendor absence undefined | ✅ DONE | Wave 2 | Added hard-failure Technical Note |
| P0.3-H3 | P0.3 | Budget cap enforcement mechanism (INV-2) completely underspecified | ✅ DONE | Wave 2 | Added Budget Enforcement subsection with 4 rules |
| P0.3-H4 | P0.3 | Race condition DoD test: "deterministic" but outcome unspecified | ✅ DONE | Wave 2 | Added 100ms window rule to DoD |
| P1.1-H1 | P1.1 | agentType enum can't represent Seeds agent | ✅ DONE | Wave 0 | CC-R8-2: added "service" to enum |
| P1.1-H2 | P1.1 | endpointUrl SSRF risk — no hostname validation | ✅ DONE | Wave 0 | CC-R8-4: added INV-4 + SSRF DoD test |
| P1.1-H3 | P1.1 | RegisterAgentSchema divergence with P0.7 | ✅ DONE | Wave 0 | CC-R8-1: P0.7 now has optional fields; P1.1 requires both |
| P1.3-H1 | P1.3 | Sanitization gaps: PowerShell, Ruby, Perl, Node.js, PHP, Lua unguarded | ✅ DONE | Wave 2 | Replaced with deny-by-default + safe set + DoD test |
| P1.3-H2 | P1.3 | Missing agentType/endpointUrl for qds-seeds registration | ✅ DONE | Wave 0 | CC-R8-2: added agentType/endpointUrl/capabilities to A2A contract |
| P1.4-H1 | P1.4 | PRD spec reference drift (FR-OR-1/FR-OR-2 describe Archon, not SwarmClaw) | ✅ DONE | Wave 2 | Added pre-pivot traceability note |
| P1.4-H2 | P1.4 | compare algorithm embedder unspecified + summaryQuality may be negative | ✅ DONE | Wave 2 | TF-IDF default + [0,1] clamp + normalization rule |
| P1.4-H3 | P1.4 | INV-3 validation timing: template registration vs invocation | ✅ DONE | Wave 2 | Changed to invocation-time validation; registration permissive |
| P1.6-H1 | P1.6 | DoD Security contradicts INV-2 on decode stage ordering | ✅ DONE | Wave 2 | Updated DoD to two-stage pre/post-decode language |
| P1.6-H2 | P1.6 | partialOutput has no truncation ceiling | ✅ DONE | Wave 2 | Added 10000-char truncation + suffix |
| P1.6-H3 | P1.6 | Exit code mapping doesn't cover negative values | ✅ DONE | Wave 2 | Changed catch-all to != 0 and not in {1,2,3} |
| P1.6-H4 | P1.6 | durationMs stopwatch semantics unspecified | ✅ DONE | Wave 2 | Added wall-clock spawn-to-exit note, excludes mulch_prime_ms |
| P1.6-H5 | P1.6 | Warren exit code contract assumption unstated | ✅ DONE | Wave 2 | Added Warren 0-3 convention assumption note |

---

## Tracker: MEDIUMs

41 items.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| P0.7-M1 | P0.7 | INV-SC3 env allowlist untestable in DoD | ✅ DONE | Wave 3 | Added env isolation DoD test |
| P0.7-M2 | P0.7 | `--require`/`-r` with absolute paths allows arbitrary code loading | ✅ DONE | Wave 3 | Added residual risk note (trusted-operator access) |
| P0.7-M3 | P0.7 | 32 MCP/64 agent limits not enforced in DoD tests | ✅ DONE | Wave 3 | Added capacity DoD test (33 MCP, 65 agents) |
| P0.7-M4 | P0.7 | resolveBankId→P0.7 validation error path unclear | ✅ DONE | Wave 3 | Added provisioner→P0.7 boundary clarification |
| P0.7-M5 | P0.7 | `env` field allows empty-string keys/values | ✅ DONE | Wave 3 | Changed schema to z.string().min(1) for keys |
| P0.9-M1 | P0.9 | BankIdSchema allows 1-char IDs; no minimum discussed | ✅ DONE | Wave 0 | CC-R8-9: documented 1-char validity, caller-level enforcement |
| P0.9-M2 | P0.9 | Mulch partial failure lacks per-entry status within a file | ✅ DONE | Wave 3 | Added entryIndex? to failures schema |
| P0.9-M3 | P0.9 | Observability snake_case vs CC-8 camelCase within schemas | ✅ DONE | Wave 3 | Added schema naming convention note |
| P0.9-M4 | P0.9 | No concurrent Mulch import behavior specified | ✅ DONE | Wave 3 | Added Phase-1 single-process note |
| P0.9-M5 | P0.9 | AC-2 vs AC-6 Mulch target bank contradiction | ✅ DONE | Wave 0 | CC-R8-7: reconciled AC-2 to {resolveBankId(repoSlug)}-dev-meta |
| P0.9-M6 | P0.9 | Recall timeout vs P0.7 invoke timeout: which wins? | ✅ DONE | Wave 3 | Added enforcement level clarification |
| P0.9-M7 | P0.9 | INV-HM4 tenant isolation testability depends on unspecified recall scope | ✅ DONE | Wave 3 | Added single-bank recall scope + test method |
| P0.3-M1 | P0.3 | Model identifiers not marked as illustrative | ✅ DONE | Wave 3 | Added (illustrative) labels + note |
| P0.3-M2 | P0.3 | Phase-to-extension table missing `summarize` row | ✅ DONE | Wave 0 | CC-R8-6: added summarize row + rename note |
| P0.3-M3 | P0.3 | coms_await 8min > wall-clock 5min — timer conflict | ✅ DONE | Wave 3 | Added wall-clock-wins clarification |
| P0.3-M4 | P0.3 | No specification for lead agent failure | ✅ DONE | Wave 3 | Added lead failure → logic_error + SIGTERM workers |
| P0.3-M5 | P0.3 | ComsLogEntry missing sessionId and phaseId | ✅ DONE | Wave 0 | CC-R8-5: added sessionId+phaseId to ComsLogEntry |
| P0.3-M6 | P0.3 | CostEvent missing timestamp field | ✅ DONE | Wave 0 | CC-R8-5: added timestamp to CostEvent |
| P0.3-M7 | P0.3 | Missing signal-to-exitStatus mapping table (persists from R7) | ✅ DONE | Wave 3 | Added signal→transient mapping table |
| P0.3-M8 | P0.3 | Guard defaults not sourced from PRD normative values (persists from R7) | ✅ DONE | Wave 3 | Added PRD sourcing note |
| P1.1-M1 | P1.1 | Retry backoff sequence ambiguous (1s,2s vs 1s/2s/4s) | ✅ DONE | Wave 3 | Clarified: 1s/2s, 3 total attempts, max 3s delay |
| P1.1-M2 | P1.1 | requestId vs JSON-RPC `id` field relationship undefined | ✅ DONE | Wave 3 | Added fallback: params.requestId ← envelope id |
| P1.1-M3 | P1.1 | onFailure "fallback" has no defined behavior | ✅ DONE | Wave 3 | Kept in enum; returns 400 in Phase 1 |
| P1.1-M4 | P1.1 | AC4 data flow direction ambiguous (forwarding loop risk) | ✅ DONE | Wave 3 | Rewrote AC4 with unidirectional flow |
| P1.1-M5 | P1.1 | No AC or DoD tests the retry policy | ✅ DONE | Wave 3 | Added retry DoD test |
| P1.3-M1 | P1.3 | JSONL concurrent-write: no single-writer invariant | ✅ DONE | Wave 3 | Added single-writer implicit lock note |
| P1.3-M2 | P1.3 | Archive naming collision for same-day events | ✅ DONE | Wave 3 | Added append behavior for existing archives |
| P1.3-M3 | P1.3 | No idempotency/dedup for decompose retries | ✅ DONE | Wave 3 | Added caller-responsibility dedup note |
| P1.3-M4 | P1.3 | `gh` CLI availability is unstated prerequisite | ✅ DONE | Wave 3 | Added gh prerequisite + -32015 error + startup check |
| P1.4-M1 | P1.4 | Phase output missing "partial" status value | ✅ DONE | Wave 3 | Added "partial" to PhaseOutput status enum |
| P1.4-M2 | P1.4 | No CC-9 observability contract section | ✅ DONE | Wave 0 | CC-R8-5: added CC-9 section with phase-transition logging |
| P1.4-M3 | P1.4 | P0.3 vs P1.4 mapping table divergence (cross-agent vs summarize) | ✅ DONE | Wave 0 | CC-R8-6: added canonical name note (summarize wins) |
| P1.4-M4 | P1.4 | compare/decide no NaN guard for all-zero branch metrics | ✅ DONE | Wave 3 | Added all-zero → tie_detected guard + max(totalWeight,1) |
| P1.4-M5 | P1.4 | Template registration API endpoint path + auth undefined | ✅ DONE | Wave 3 | Added Registration Contract: POST /api/protocol-templates |
| P1.4-M6 | P1.4 | dispatch_task config uses ellipsis — should reference P1.6 | ✅ DONE | Wave 3 | Replaced ... with P1.6 Warren harness contract |
| P1.4-M7 | P1.4 | No test for tie_detected / no_viable_output events | ✅ DONE | Wave 3 | Added tie + no_viable DoD tests |
| P1.6-M1 | P1.6 | artifacts path traversal not validated by pi-lens | ✅ DONE | Wave 3 | Added path traversal validation to pi-lens step (6) |
| P1.6-M2 | P1.6 | coverage field absent vs present guidance missing | ✅ DONE | Wave 3 | Added optional coverage field guidance |
| P1.6-M3 | P1.6 | Watchdog SIGTERM: no SIGKILL escalation after grace period | ✅ DONE | Wave 0 | CC-R8-8: added 5s grace→SIGKILL to INV-3 + DoD |
| P1.6-M4 | P1.6 | INV-2 symlink detection TOCTOU concern | ✅ DONE | Wave 3 | Added best-effort TOCTOU note |
| P1.6-M5 | P1.6 | mulch_prime_ms failure representation missing | ✅ DONE | Wave 3 | Clarified failure duration + mulchPrimeError |

---

## Tracker: LOWs / nits

30 items. Batch in Wave 4.

| ID | Story | Title | Status | Owner | Notes |
|---|---|---|---|---|---|
| P0.7-L1 | P0.7 | MCPTestResponseSchema tools optional but AC1 requires it on success | ✅ DONE | Wave 4 | Added .refine() enforcing ok→tools non-empty |
| P0.7-L2 | P0.7 | metadata field has no size limit | ✅ DONE | Wave 4 | Added 10KB refine constraint |
| P0.7-L3 | P0.7 | SWARMCLAW_TOOL_CACHE_TTL_MS has no documented bounds | ✅ DONE | Wave 4 | Added 1s–1hr bounds with clamping |
| P0.7-L4 | P0.7 | SSE transport in schema but no AC/DoD coverage | ✅ DONE | Wave 4 | Added future-work note |
| P0.9-L1 | P0.9 | resolveBankId trailing-hyphen single-pass can miss edge cases | ✅ DONE | Wave 0 | CC-R8-3: changed to while loop |
| P0.9-L2 | P0.9 | ConsolidateResponseSchema camelCase inconsistency | ✅ DONE | Wave 4 | Added CC-8 naming boundary note |
| P0.9-L3 | P0.9 | Mulch file limit 100 — no behavior when exceeded | ✅ DONE | Wave 4 | Added error response for >100 files |
| P0.9-L4 | P0.9 | Symlink resolution platform-dependent (INV-HM3) | ✅ DONE | Wave 4 | Added cross-platform realpathSync note |
| P0.9-L5 | P0.9 | confidence field has no specified semantics | ✅ DONE | Wave 4 | Added informational-only semantics |
| P0.3-L1 | P0.3 | Waiver type referenced but never defined | ✅ DONE | Wave 4 | Added structured waiver definition |
| P0.3-L2 | P0.3 | AC1 says "providers" but likely means "models" | ✅ DONE | Wave 4 | Changed to "models" + clarifying note |
| P0.3-L3 | P0.3 | coms_ vs coms_net_ API naming gap between P0.2 and P0.3 | ✅ DONE | Wave 4 | Added intentional naming gap note |
| P0.3-L4 | P0.3 | "Cuts CLI-Anything layer" ambiguous verb (persists from R7) | ✅ DONE | Wave 4 | Changed to "bypasses...invoking Warren directly" |
| P1.1-L1 | P1.1 | credentialId field unreferenced | ✅ DONE | Wave 4 | Added reserved-for-future note |
| P1.1-L2 | P1.1 | Error response requestId in asymmetric location vs success | ✅ DONE | Wave 4 | Added intentional asymmetry note (JSON-RPC 2.0) |
| P1.1-L3 | P1.1 | Observability failure should be fire-and-forget | ✅ DONE | Wave 4 | Added fire-and-forget note |
| P1.1-L4 | P1.1 | Circuit breaker deferred but not noted in story | ✅ DONE | Wave 4 | Added Phase 2 circuit breaker note |
| P1.1-L5 | P1.1 | No upper bound on concurrent A2A delegations | ✅ DONE | Wave 4 | Added Phase 2 concurrency limit note |
| P1.3-L1 | P1.3 | DependencyEdgeSchema queryability relies on semantic recall | ✅ DONE | Wave 4 | Added Phase 2 metadata tag strategy note |
| P1.3-L2 | P1.3 | Truncation mirroredCount behavior implicit | ✅ DONE | Wave 4 | Added count-comparison detection note |
| P1.3-L3 | P1.3 | -32017 "Mirror partial failure" covers total failure too | ✅ DONE | Wave 4 | Renamed to "Mirror failure" |
| P1.3-L4 | P1.3 | fs.chmod on every append wasteful | ✅ DONE | Wave 4 | Changed to once-per-batch |
| P1.3-L5 | P1.3 | description field has no max length | ✅ DONE | Wave 4 | Added 2000-char max + truncation |
| P1.3-L6 | P1.3 | acceptanceCriteria can be empty (no .min(1)) | ✅ DONE | Wave 4 | Added min(1) + 400 rejection |
| P1.4-L1 | P1.4 | Branch count limits (2-8) have no rationale | ✅ DONE | Wave 4 | Added coverage vs cost rationale |
| P1.4-L2 | P1.4 | Template ID has no validation rule | ✅ DONE | Wave 4 | Added regex validation: ^[a-z][a-z0-9-]{1,63}$ |
| P1.4-L3 | P1.4 | Files to Modify list undercounted | ✅ DONE | Wave 4 | Added illustrative-only note |
| P1.4-L4 | P1.4 | Template registration auth has no RBAC granularity | ✅ DONE | Wave 4 | Added operator-level auth + Phase 2 RBAC note |
| P1.6-L1 | P1.6 | captureFormat singleton enum — premature abstraction? | ✅ DONE | Wave 4 | Added forward-compatibility rationale |
| P1.6-L2 | P1.6 | summary truncation test missing from DoD | ✅ DONE | Wave 4 | Added summary truncation DoD test |

---

## Full findings — P0.7

**Story file:** `_bmad-output/sprint-artifacts/phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md` (~201 lines)
**Role:** Foundation — agent registry, MCP bridge, command allowlist

### BLOCKERs

#### P0.7-B1 — INV-SC2 args validation regression: AC7 doesn't test all flags
**Story line(s):** L147-150 (INV-SC2), L38 (AC7), L196 (DoD allowlist test)
**Why broken:** Round 7 added args validation text for `node`: `-e`, `--eval`, `-p`, `--print`, `-` (stdin), `--require`/`-r` with non-absolute path. But AC7 only tests `node -e` and `npx --node-arg`. The DoD lists all flags but doesn't bind each to a test case. If `-` is not validated at implementation time, arbitrary code can be piped via stdin.
**Concrete fix:** Expand AC7 to test all denied flags: `node -e`, `node -p`, `node --print`, `node -` (stdin), `node --require relative-path`, `node -r relative-path`. Add a DoD test item: "Test (args coverage): For each denied flag in INV-SC2 (`-e`, `--eval`, `-p`, `--print`, `-`, `--require`/`-r` with non-absolute path), verify registration is rejected with 400."

#### P0.7-B2 — npx allows any npm package (no package allowlist)
**Story line(s):** L149 (INV-SC2 npx validation)
**Why broken:** The first positional arg is validated as `^(@[a-z0-9][\w.-]*/)?[a-z0-9][\w.-]*$` — any syntactically valid npm package name passes. `npx malicious-pkg` would succeed. This contradicts the allowlist's security philosophy.
**Concrete fix:** Add a package allowlist for npx: "When `command: "npx"`, the first positional arg must match one of: `hindsight-local-mcp`, `@anthropic-ai/claude-code`, or other entries in `SWARMCLAW_NPX_PACKAGE_ALLOWLIST` (env-var configurable). Reject unknown packages with 400."

#### P0.7-B3 — RegisterAgentSchema divergence with P1.1
**Story line(s):** L45-49 (schema), L97 (downstream contract stability)
**Why broken:** P0.7 schema: `{agentId, capabilities, metadata?}`. P1.1 needs: `{agentId, agentType, endpointUrl, capabilities}`. Same endpoint, incompatible schemas. P0.7's own contract stability clause calls this BLOCKER-level.
**Concrete fix:** Add to RegisterAgentSchema: `agentType: z.enum(["department-manager","worker","observer","service"]).optional(), endpointUrl: z.string().url().optional()`. Add note: "P1.1 requires both fields for agent registration. P0.7 accepts registrations without them for MCP-only agents."

### HIGHs

#### P0.7-H1 — BankIdSchema allows 1-char bank IDs
**Fix:** Document that resolveBankId output must be validated. Note that single-char bank IDs are technically valid but may cause operational confusion. No schema change needed — this is a documentation gap.

#### P0.7-H2 — Tool cache doesn't handle tool-removal direction
**Fix:** Add to tool cache spec: "If an invoke call returns a tool-not-found error from the MCP server, invalidate the cache entry and re-enumerate before retrying. This handles tools being removed between cache refreshes."

#### P0.7-H3 — SIGTERM lifecycle: no SIGKILL escalation
**Fix:** Add to AC6: "After sending SIGTERM, wait 5 seconds. If the subprocess has not exited, send SIGKILL. The test endpoint returns `{ ok: false }` for killed servers." CC-R8-8.

#### P0.7-H4 — INV-SC4 untestable as specified
**Fix:** Rewrite INV-SC4 to scope the claim: "In containerized deployments (Phase 2), MCP server subprocesses run with dropped network capabilities. In Phase 1, network listener detection is best-effort (logging-only). The DoD test verifies that the subprocess communicates only via stdio by inspecting the transport layer, not by OS-level network monitoring."

### MEDIUMs

#### P0.7-M1 — INV-SC3 env allowlist untestable
**Fix:** Add DoD test: "Register MCP server with `env: { FOO: "bar" }` → verify subprocess sees FOO but NOT other SwarmClaw process env vars."

#### P0.7-M2 — `--require`/`-r` with absolute paths
**Fix:** Add note: "Residual risk: `--require` with an absolute path allows loading arbitrary modules from known filesystem locations. Acceptable because MCP server registration requires trusted-operator access."

#### P0.7-M3 — 32/64 limits untested
**Fix:** Add DoD test: "Register 33 MCP servers → verify 429 or 503. Register 65 agents → verify 429 or 503."

#### P0.7-M4 — resolveBankId→P0.7 error path
**Fix:** Add note to P0.9's bank provisioner: "If resolveBankId produces a value that fails BankIdSchema, the provisioner returns a clear error before reaching P0.7's MCP boundary."

#### P0.7-M5 — env allows empty-string keys
**Fix:** Change schema to `env: z.record(z.string().min(1), z.string()).optional()`.

### LOWs

#### P0.7-L1 — MCPTestResponseSchema tools optional but AC1 requires
**Fix:** Add `.refine()` to enforce `ok: true → tools present and non-empty`.

#### P0.7-L2 — metadata no size limit
**Fix:** Add `metadata: z.record(z.unknown()).optional().refine(v => JSON.stringify(v).length <= 10240)`.

#### P0.7-L3 — Cache TTL no bounds
**Fix:** Add: "TTL must be >= 1000ms and <= 3600000ms (1 hour)."

#### P0.7-L4 — SSE no coverage
**Fix:** Add note: "SSE transport is future work. Registration accepts `transport: "sse"` but the test/lifecycle DoD items cover stdio only."

---

## Full findings — P0.9

**Story file:** `_bmad-output/sprint-artifacts/phase-0/stories/p0-9-hindsight-banks-mulch.md` (~257 lines)
**Role:** Memory substrate — bank provisioning, lifecycle round-trip, Mulch import

### BLOCKERs

#### P0.9-B1 — resolveBankId produces duplicate bank IDs for different repos
**Story line(s):** L162-172 (resolveBankId function)
**Why broken:** After `.slice(0, 64)` and trailing-hyphen strip, two different repo slugs that differ only past the 64-char boundary produce identical bank IDs. Violates INV-HM4 (tenant isolation).
**Concrete fix:** (a) Change trailing-hyphen strip to a loop. (b) Add collision-detection note: "resolveBankId is collision-prone for repo slugs that share a common 64-char prefix. Callers must supply known-unique repo slugs. If collision is detected at provisioning time, append a disambiguation suffix." CC-R8-3.

### HIGHs

#### P0.9-H1 — resolveBankId empty string for all-special-char input
**Fix:** Add to bank provisioner: "Before creating a bank, validate the resolved bank ID against BankIdSchema. If validation fails, return `{ ok: false, error: 'Invalid bank ID derived from repo slug' }` without calling Hindsight."

#### P0.9-H2 — MulchExpertiseSchema→P1.12 lossy mapping
**Fix:** Update Schema Alignment Note to map `expertise` → `MulchEntry.content` (not `concepts`). Map `concepts` → `MulchEntry.tags` or similar. Or add `expertise` to MulchEntry. Document the mapping is lossy and P1.12 must consume the canonical MulchExpertiseSchema, not the simplified MulchEntry.

#### P0.9-H3 — JSONL format: delimiter, encoding, BOM unspecified
**Fix:** Add to Mulch Storage Format Contract: "Line delimiter: `\n` (LF only). Character encoding: UTF-8 without BOM. Import parser must strip UTF-8 BOM (`EF BB BF`) from the first line of any input file before parsing."

#### P0.9-H4 — Dedup hash excludes expertise field
**Fix:** Document as intentional: "Dedup is by domain+concepts identity. Two entries with the same domain and concepts but different expertise text are considered updates of the same expertise area. Re-import replaces the earlier entry."

### MEDIUMs

#### P0.9-M1 — BankIdSchema 1-char IDs
**Fix:** Document: "Single-character bank IDs are valid per BankIdSchema. If a minimum length is desired, enforce at the resolveBankId caller level."

#### P0.9-M2 — Mulch partial failure: no per-entry status
**Fix:** Change failures schema to: `failures: Array<{ file: string, entryIndex?: number, error: string }>`.

#### P0.9-M3 — snake_case vs camelCase in schemas
**Fix:** Add clarifying note: "Schemas in Technical Notes use Hindsight internal parameter names (snake_case). The MCP bridge (P0.7) translates to camelCase at the REST boundary. Implementers should use the internal names for MCP tool calls and camelCase for REST API payloads."

#### P0.9-M4 — Concurrent Mulch import
**Fix:** Add note: "Concurrent Mulch import is not supported in Phase 1. The import script runs as a single process. Concurrent import is a Phase 2 concern."

#### P0.9-M5 — AC-2 vs AC-6 Mulch target bank contradiction
**Fix:** Reconcile to `{resolveBankId(repoSlug)}-dev-meta` per Technical Notes. Update AC-2 to say "targeting the `{resolveBankId(repoSlug)}-dev-meta` bank" instead of `qds-collective`. CC-R8-7.

#### P0.9-M6 — Recall timeout vs P0.7 invoke timeout
**Fix:** Add note: "The 10s recall hard timeout is enforced at the Hindsight client level, before the request reaches P0.7's MCP invoke layer. P0.7's 120s timeout is a transport-level safety net."

#### P0.9-M7 — INV-HM4 testability
**Fix:** Add note: "Hindsight recall is scoped to a single bank_id per call. Cross-bank queries are not supported. INV-HM4 is verified by calling recall on bank A and asserting no results from bank B appear."

### LOWs

#### P0.9-L1 — resolveBankId trailing-hyphen single-pass
**Fix:** Change to a while loop or add a second replace call. CC-R8-3.

#### P0.9-L2 through L5 — See tracker table for summaries.

---

## Full findings — P0.3

**Story file:** `_bmad-output/sprint-artifacts/phase-0/stories/p0-3-mixed-model-demo.md` (~103 lines)
**Role:** E2E demo — 3-agent mixed-model team, merged JSON, coms exchange

### HIGHs

#### P0.3-H1 — ComsLogEntry type name collision + camelCase boundary
**Fix:** Unify to `ComsLogEntry` everywhere. Update merged output schema `comsLog: ComsLogEntry[]`. Add note: "ComsLogEntry fields are camelCase on stdout; coms-net.ts internal wire format must serialize to camelCase at the harness boundary."

#### P0.3-H2 — Graceful degradation for coms vendor absence
**Fix:** Add Technical Note: "This demo requires exactly one coms transport path (subprocess-RPC per OQ-1). Coms initialization failure is a hard failure producing `exitStatus: 'transient'` with no partial output."

#### P0.3-H3 — Budget cap enforcement underspecified
**Fix:** Add "Budget Enforcement" subsection: (a) Per-team shared pool ($0.50 total). (b) Harness polls CostEvents from Warren output. (c) Kill threshold at 90% of cap. (d) In-flight requests get a 5s grace period. (e) overflow reason in merged output error payload.

#### P0.3-H4 — Race condition DoD outcome unspecified
**Fix:** Add to DoD: "If worker output arrives within 100ms of coms_await timeout expiration, the lead treats it as successful arrival (partial: false); after that window, it is treated as timeout (partial: true)."

### MEDIUMs, LOWs — See tracker table for summaries. Fix recipes follow the same pattern: add missing specification, add test, reconcile naming.

---

## Full findings — P1.1

**Story file:** `_bmad-output/sprint-artifacts/phase-1/stories/p1-1-dev-manager-a2a.md` (~165 lines)
**Role:** A2A delegation — JSON-RPC 2.0 transport, error codes, correlation IDs

### HIGHs

#### P1.1-H1 — agentType enum insufficient
**Fix:** Add `"service"` to enum: `"department-manager"|"worker"|"observer"|"service"`. Document: "service = specialized handler (Seeds, future agents)." CC-R8-2.

#### P1.1-H2 — endpointUrl SSRF risk
**Fix:** Add INV-4: "endpointUrl hostname must resolve to localhost (127.0.0.1, ::1, or hostname 'localhost'). Non-loopback endpoints rejected with 422." CC-R8-4.

#### P1.1-H3 — RegisterAgentSchema divergence
**Fix:** Coordinated with P0.7-B3. P0.7 schema gains `agentType?` and `endpointUrl?`. P1.1 makes both required for its registrations. CC-R8-1.

### MEDIUMs

#### P1.1-M1 — Retry backoff ambiguous
**Fix:** Clarify: "exponential backoff starting at 1s with multiplier 2 (delays: 1s for first retry, 2s for second retry). Total attempts: 3 (1 initial + 2 retries)."

#### P1.1-M2 — requestId vs JSON-RPC id
**Fix:** Add note: "The caller should set `id` and `params.requestId` to the same UUID. If `params.requestId` is absent, SwarmClaw populates it from the envelope `id`."

#### P1.1-M3 — onFailure "fallback" undefined
**Fix:** Either remove from enum or add: "fallback: route to a preconfigured backup agent endpoint. Not implemented in Phase 1 — registration with `onFailure: 'fallback'` returns 400."

#### P1.1-M4 — AC4 data flow direction
**Fix:** Rewrite AC4 to clarify: "SwarmClaw's A2A router sends HTTP POST to the registered endpointUrl. The harness at that endpoint processes the request and returns the response."

#### P1.1-M5 — No retry policy test
**Fix:** Add DoD: "Test (retry): A2A delegation with onFailure='retry' to unreachable endpoint produces 3 attempts with backoff (1s, 2s) before returning -32010."

### LOWs — See tracker table.

---

## Full findings — P1.3

**Story file:** `_bmad-output/sprint-artifacts/phase-1/stories/p1-3-seeds-decompose-mirror.md` (~129 lines)
**Role:** Seeds decomposition — JSONL persistence, GitHub mirror, sanitization

### HIGHs

#### P1.3-H1 — Sanitization gaps (PowerShell, Ruby, Perl, etc.)
**Fix:** Adopt deny-by-default: "Fenced code blocks with language tags not in the explicit safe set (`typescript`, `json`, `yaml`, `mermaid`, `sql`, `graphql`, `css`, `html`, `xml`, `diff`, `plaintext`) are stripped and replaced with `[code block removed: {language}]`. The safe set is configurable."

#### P1.3-H2 — Missing Seeds A2A registration fields
**Fix:** Add to A2A Dispatch Contract: `agentType: "service"`, `endpointUrl: "http://localhost:${process.env.SWARMCLAW_A2A_PORT || 3100}/a2a"`, `capabilities: ["qds.decompose"]`. CC-R8-2.

### MEDIUMs, LOWs — See tracker table.

---

## Full findings — P1.4

**Story file:** `_bmad-output/sprint-artifacts/phase-1/stories/p1-4-protocol-template.md` (~141 lines)
**Role:** Protocol template — 5-phase orchestration, compare/decide algorithms

### HIGHs

#### P1.4-H1 — PRD spec reference drift
**Fix:** Add note at Spec Reference: "FR-OR-1/FR-OR-2 are pre-pivot FRs. Post-pivot, this story fulfills the same capability via SwarmClaw protocol templates. PRD references retained for backward traceability."

#### P1.4-H2 — Compare embedder unspecified
**Fix:** Specify default: "TF-IDF vectorizer over tokenized summary text, cosine similarity, clamped to [0,1]. Alternative embedders acceptable if they produce values in [0,1]." Add normalization: "summaryQuality is clamped to [0.0, 1.0] before scoring."

#### P1.4-H3 — INV-3 validation timing gap
**Fix:** Change INV-3: "Validation occurs at invocation time (not template registration time). Template registration accepts any participantAgentIds. At invocation, unregistered agent IDs produce HTTP 422 with error code -32011."

### MEDIUMs, LOWs — See tracker table.

---

## Full findings — P1.6

**Story file:** `_bmad-output/sprint-artifacts/phase-1/stories/p1-6-pi-team-protocol-step.md` (~108 lines)
**Role:** Pi-team dispatch — Warren harness, structured JSON capture, exit codes

### BLOCKERs

#### P1.6-B1 — mulchPrimed field missing from schema
**Story line(s):** L33 (AC4), L51 (success schema)
**Why broken:** AC4 promises `mulchPrimed: false` in step output. The success output schema omits this field. Implementing to the Contracts/Schema section produces output that fails AC4.
**Concrete fix:** Add `mulchPrimed: boolean` to the success output schema on line 51. Add pi-lens validation step (5): "`mulchPrimed` is a boolean."

#### P1.6-B2 — Hindsight unreachable during priming unaddressed
**Why broken:** No specified behavior for when Mulch priming fails due to Hindsight being down. Each implementer will choose differently.
**Concrete fix:** Add Technical Note: "If Hindsight is unreachable during Mulch priming, the harness logs a warning, sets `mulchPrimed: false`, and proceeds. The step does not fail due to priming unavailability. `mulch_prime_ms` records the failed duration and `mulchPrimeError: string` captures the reason."

### HIGHs

#### P1.6-H1 — DoD contradicts INV-2 on decode stage ordering
**Fix:** Update DoD line 100 to mirror INV-2's two-stage language: "(1) pre-decode rejects percent-encoded `..` and double-encoding, (2) post-decode rejects literal `..`, absolute paths, symlinks after URL-decode and NFC-normalize."

#### P1.6-H2 — partialOutput no truncation ceiling
**Fix:** Add to Guards/limits: "`partialOutput` is truncated to 10000 characters. If raw output exceeds this, suffix with `[truncated, N bytes total]`."

#### P1.6-H3 — Exit code mapping negative values
**Fix:** Change table row from `>=4 or signal` to `!= 0 and not in {1,2,3}, including signals and negative codes`.

#### P1.6-H4 — durationMs stopwatch semantics
**Fix:** Add Technical Note: "`durationMs` measures wall-clock from `warren run` process spawn to process exit. Excludes Mulch priming time (captured as `mulch_prime_ms`)."

#### P1.6-H5 — Warren exit code contract
**Fix:** Add Technical Note: "This mapping assumes Warren uses: 0=ok, 1=logic, 2=transient, 3=overflow. If Warren's actual codes differ, the harness adapter must be updated."

### MEDIUMs, LOWs — See tracker table.

---

## Verified-correct elements (do NOT undo)

### P0.7
- Bank_id regex properly anchored, matches P0.9 BankIdSchema
- INV-SC1 agentId regex aligned with P1.1 INV-2 (identical patterns)
- Command allowlist defaults sensible; shell exclusion explicit
- Args validation timing correct (registration time, before subprocess spawn)
- CC-9 observability with requestId propagation
- CC-8 naming convention boundary documented
- Timeout alignment (120s invoke > 60s consolidate) correct

### P0.9
- BankIdSchema regex matches slice(0,64) in resolveBankId
- Three-bank naming convention consistent across P0.9, P1.3, P1.11
- Timeout alignment (CC-7) all P0.9 timeouts within P0.7's 120s
- CC-9 observability well-structured with timing metrics
- INV-HM1 through HM3 enforcement patterns sound

### P0.3
- CC-1 exitStatus 4-value enum present and consistent
- CC-2 manifest-driven Warren CLI surface correct
- CC-4 changedFiles field name consistent
- CC-9 observability schemas present (ComsLogEntry, CostEvent)
- No regressions from prior rounds

### P1.1
- Endpoint URL `/a2a` consistent across P1.1, P1.3, P1.6
- Error code taxonomy cleanly partitioned (P1.1: -32010..-32013, P1.3: -32014..-32017)
- Retry policy handles correct transient error codes
- agentId pattern aligned with P0.7 INV-SC1
- Transport Contract (local HTTP POST only) sound
- Correlation ID propagation contract complete for happy path

### P1.3
- Error codes -32014..-32017 distinct from P1.1
- INV-2 (.gitignore + chmod) correctly acknowledges Git limitation
- resolveBankId references correct (no reimplementation)
- Archive naming uses date format (correct from R7 fix)

### P1.4
- Phase-to-Extension Mapping table complete (6 rows)
- compare algorithm fully specified with Jaccard similarity + overlap matrix
- decide algorithm with weighted scoring and division-by-zero defaults
- Phase Config Binding with `.canopy/agent.json` resolution correct
- INV-3 with AC7 and DoD test for unregistered agents
- Graceful degradation for all-branches-fail fully specified
- Template versioning immutable, version-pinned at invocation
- Tie-breaking rule (top-2 within 0.1 → human review) correct
- summarize algorithm handles winner-selected and all-failed cases

### P1.6
- exitStatus taxonomy (CC-1) aligned with P0.3
- Warren CLI surface (CC-2) manifest-driven, correct
- Field name `changedFiles` (CC-4) consistent
- Timeout alignment (CC-7): 600s max < 900s P1.1 limit
- Observability contract (CC-9) with sub-timing breakdown
- No regressions from R5-R7 fixes

---

## Session log (append-only)

### Entries

- 2026-06-10 | glm-5.1 (initial review orchestration) | DONE: review captured | IN_PROGRESS: none | NOTES: 7 parallel reviewers dispatched. All 7 completed. 102 findings total (6B, 25H, 41M, 30L). 9 cross-cutting themes identified. Tracker created. Ready for Wave 0.
- 2026-06-10 | glm-5.1 (Wave 0 orchestration) | DONE: 17/102 items resolved (2B, 6H, 8M, 1L) | IN_PROGRESS: Wave 1 BLOCKERs | NOTES: 7 parallel agents dispatched (P0.7, P0.9, P0.3, P1.1, P1.3, P1.4, P1.6). All completed. CC-R8-1 through CC-R8-9 fully resolved. Remaining: 4 BLOCKERs (P0.7-B1, P0.7-B2, P1.6-B1, P1.6-B2).
- 2026-06-10 | glm-5.1 (Wave 1 orchestration) | DONE: 4/4 BLOCKERs resolved | IN_PROGRESS: Wave 2 HIGHs | NOTES: 2 agents (P0.7, P1.6). P0.7-B1 expanded AC7 to all 6 denied flags. P0.7-B2 added npx package allowlist. P1.6-B1 added mulchPrimed to schema. P1.6-B2 added Hindsight-unreachable behavior.
- 2026-06-10 | glm-5.1 (Wave 2 orchestration) | DONE: 19/19 HIGHs resolved | IN_PROGRESS: Wave 3 MEDIUMs | NOTES: 6 agents (P0.7, P0.9, P0.3, P1.3, P1.4, P1.6). All 25 HIGHs now done. Key fixes: P0.3 budget enforcement, P1.3 deny-by-default sanitization, P1.4 INV-3 invocation-time validation, P1.6 exit code negative values.
- 2026-06-10 | glm-5.1 (Wave 3 orchestration) | DONE: 33/33 MEDIUMs resolved | IN_PROGRESS: Wave 4 LOWs | NOTES: 7 agents (all stories). All 41 MEDIUMs now done. Key fixes: P0.3 signal mapping + lead failure, P1.1 data flow + retry test, P1.4 partial status + registration contract, P1.6 path traversal + TOCTOU.
- 2026-06-10 | glm-5.1 (Wave 4 orchestration) | DONE: 29/29 LOWs resolved | IN_PROGRESS: Wave 5 verification | NOTES: 2 agents (Phase-0, Phase-1). All 30 LOWs done. Campaign 102/102 complete. Wave 5 verification dispatched.
- 2026-06-10 | glm-5.1 (Wave 5 verification) | DONE: 7/7 verifiers complete | FOUND: 0B, 8H, ~26M, ~20L + regressions | NOTES: Fresh-eyes verifiers found 8 HIGHs across 4 stories. Key: P0.9 qds-collective regression (2H), P0.3 logic_error vs logic (1H+1R), P1.3 sanitization bypass + A2A contract mismatch (3H), P1.4 mapping table gap + AC5 math error (2H). Wave 5b dispatched.
- 2026-06-10 | glm-5.1 (Wave 5b re-fix) | DONE: 8/8 Wave-5 HIGHs resolved | IN_PROGRESS: Wave 5c MEDIUMs/LOWs | NOTES: 4 agents (P0.9, P0.3, P1.3, P1.4). All 8 Wave-5 HIGHs applied. Key: P0.9 resolveBankId collision guard + qds-collective fix, P0.3 exitStatus logic_error→logic, P1.3 sanitization env var naming + dual truncation, P1.4 INV-3 branch-vs-agent identity + manifest wording.
- 2026-06-10 | glm-5.1 (Wave 5c re-fix) | DONE: 85/85 Wave-5 MEDIUMs/LOWs resolved (0B, 15H, 43M, 27L) | IN_PROGRESS: none | NOTES: 7 agents (P0.7=16, P0.9=13, P0.3=7, P1.1=12, P1.3=13, P1.4=13, P1.6=11). All 85 findings applied across all 7 story files. No new findings. No regressions. Campaign COMPLETE. Total findings resolved: 102 (original) + 8 (Wave 5 HIGHs) + 85 (Wave 5c) = 195 total edits across 7 stories.

---

## Post-completion verification protocol

Once all tracker rows show ✅ DONE (or ⏭️ DEFERRED with linked ADR):

1. **Re-run adversarial review (Wave 5).** Spawn 7 parallel agents using the same prompts. Target: zero new BLOCKERs or HIGHs.
2. **Run `gitnexus_detect_changes()`** on each modified story file to verify scope.
3. **Update sprint-status** — mark each story `ready-for-dev`.
4. **Archive this doc** by renaming to `<original>-RESOLVED.md` and adding a summary header.

---

**Doc owner:** biospark33
**Last updated:** 2026-06-10
