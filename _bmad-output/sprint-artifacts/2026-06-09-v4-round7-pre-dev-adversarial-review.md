# QDS-Factory v4 — Pre-Dev Adversarial Review Campaign (Round 7 — Post-Pivot Alignment)

**Date:** 2026-06-09
**Status:** 🟡 CAMPAIGN IN PROGRESS — Wave 0 ✅ (9/9 CC). Wave 1 ✅ (19/19 B). Wave 2 ✅ (30/30 H + 1 bonus M). Ready for Wave 3 MEDIUMs.
**Scope:** 7 load-bearing stories (P0.3, P0.7, P0.9, P1.1, P1.3, P1.4, P1.6)
**Mode:** Full adversarial — fresh-eyes, PRD gaps flagged as BLOCKERs
**Prior reviews (Rounds 1–6):** 30 stories reviewed across 6 rounds. PR #17 merged 2026-06-09. Round 6 initial scan incomplete — tracker skeleton only.
**Selection rationale:** Top 7 stories that establish cross-cutting contracts. Every other story depends on at least one of these. Exit gates (P0.11, P1.17) test these contracts but don't establish them.

**Pivot alignment context:**
- Stories follow layered architecture: SwarmClaw → CLI-Anything → Warren → PI
- PRD (prd-qds-factory-v4.md) is still PRE-PIVOT: Paperclip → Hermes → Archon → Pi
- PRD-vs-story mismatches are flagged as BLOCKERs in this review
- Key PRD gaps: SwarmClaw, CLI-Anything, Warren absent from PRD; exitClass "success" vs PRD's transient|overflow|logic; camelCase vs snake_case

---

## Status Dashboard

| Wave | Status | Findings | Done | Remaining |
|------|--------|----------|------|-----------|
| Initial Scan | ✅ DONE | 98 | 7 | 0 |
| Wave 0 — Cross-cutting | ✅ DONE | 9 themes | 9 | 0 |
| Wave 1 — BLOCKERs | ✅ DONE | 19 | 19 | 0 |
| Wave 2 — HIGHs | ✅ DONE | 30 | 30 | 0 |
| Wave 3 — MEDIUMs | ⬜ TODO | — | 0 | — |
| Wave 4 — LOWs | ⬜ TODO | — | 0 | — |
| Wave 5 — Verification | ⬜ TODO | — | 0 | — |
| Wave 5b — Re-fix B/H | ⬜ TODO | — | 0 | — |
| Wave 5c — Re-fix M/L | ⬜ TODO | — | 0 | — |

## Per-Story Progress

| Story | Title | SP | B | H | M | L | Total | W0 | W1 | W2 | W3 | W4 | W5 |
|-------|-------|-----|---|---|---|---|-------|----|----|----|----|-----|-----|
| P0.3 | CLI-Anything mixed-model demo | 4 | 3 | 3 | 4 | 2 | 12 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P0.7 | SwarmClaw agent + MCP Hindsight | 4 | 2 | 3 | 4 | 3 | 12 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P0.9 | Hindsight banks + Mulch | 4 | 3 | 5 | 5 | 2 | 15 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P1.1 | Dev manager A2A delegation | 3 | 2 | 4 | 5 | 3 | 14 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P1.3 | Seeds decompose mirror | 4 | 3 | 4 | 4 | 3 | 14 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P1.4 | Protocol template | 4 | 4 | 6 | 4 | 3 | 17 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| P1.6 | Pi-team via Warren | 4 | 2 | 5 | 4 | 3 | 14 | ✅ | ✅ | ✅ | ⬜ | ⬜ | ⬜ |
| **Totals** | | **27** | **19** | **30** | **30** | **19** | **98** | | | | | | |

---

## Cross-Cutting Themes

### CC-1: exitClass/status Schema Conflict (P0.3 ↔ P1.6 ↔ PRD)
- **Stories:** P0.3, P1.6, PRD §4.6
- **Issue:** P0.3 defines `exitClass: "success"|"transient"|"overflow"|"logic"`. P1.6 defines `status: "success"|"failure"`. PRD defines `exit_class: transient|overflow|logic` (failure-only, no "success"). Three incompatible taxonomies for the same concept. No translation layer specified.
- **Severity:** BLOCKER across 2 stories

### CC-2: Warren CLI Surface Undefined (P0.3 ↔ P1.6)
- **Stories:** P0.3, P1.6
- **Issue:** P0.3 uses `warren run --role-model --cname` (manifest-driven). P1.6 uses `warren run --task --agents --mulch-bank --max-duration` (flag-driven). Neither story establishes the canonical Warren CLI contract. The pivot says Warren loads `.canopy/agent.json` and invokes `pi -e extensions/<config>.ts` — neither CLI surface matches.
- **Severity:** BLOCKER across 2 stories

### CC-3: PI Extension Files Not Named (P0.3, P1.4, P1.6)
- **Stories:** P0.3, P1.4, P1.6
- **Issue:** Pivot specifies PI extensions: pi-pi.ts, agent-team.ts, coms-net.ts, agent-chain.ts, cross-agent.ts. P0.3 says "coms via socket-coms or subprocess-RPC (per P0.2 decision)" without naming extensions. P1.4 creates phase handlers at SwarmClaw layer with zero reference to PI extensions (B1). P1.6 never references `.canopy/agent.json` config layer. Phase→extension mapping from pivot (dispatch_task→agent-team.ts, parallel→pi-pi.ts, compare/decide→coms-net.ts) not documented in any story.
- **Severity:** HIGH across 3 stories (P1.4 B1 makes this a BLOCKER for P1.4 specifically)

### CC-4: Field Name Collisions (changedFiles vs filesChanged)
- **Stories:** P0.3, P1.6
- **Issue:** P0.3 uses `changedFiles`. P1.6 uses `filesChanged`. PRD uses `changed_files` (snake_case). Three names, one concept. P1.6's parser will look for `filesChanged` and find `changedFiles` from P0.3's Warren output — silent parse failure.
- **Severity:** MEDIUM (causes runtime failure)

### CC-5: JSON-RPC Error Code Enumeration Gap (P1.1, P1.3)
- **Stories:** P1.1, P1.3
- **Issue:** P1.1 has no JSON-RPC error code enumeration for A2A failure modes. P1.3 has no error codes for decompose failures. P1.10 (sibling) has explicit codes (-32600, -32000, -32001, -32602). No cross-story contract for what error codes a consumer handles when calling `/api/a2a`.
- **Severity:** HIGH across 2 stories

### CC-6: `{repo}` Placeholder Resolution Undefined (P0.9, P1.3, P1.5)
- **Stories:** P0.9, P1.3, P1.5
- **Issue:** P0.9 provisions banks `{repo}`, `{repo}-dev-meta`, `qds-collective`. The `{repo}` placeholder is never resolved. P1.3 writes to `{repo}` bank. P1.5 validates against `^{repo}-dev-meta$`. No story defines the resolution function (e.g., repo slug → bank ID).
- **Severity:** HIGH across 3 stories

### CC-7: Timeout Alignment Gaps (P0.7 ↔ P0.9, P1.1 ↔ P1.6)
- **Stories:** P0.7, P0.9, P1.1, P1.6
- **Issue:** P0.7 invoke timeout 30s < P0.9 consolidate 60s (P0.7 kills consolidate). P1.1 timeoutMs max 300s < P1.6 maxDurationMs 600s (A2A layer preempts dispatch_task).
- **Severity:** MEDIUM (P0.7→P0.9), HIGH (P1.1→P1.6)

### CC-8: snake_case vs camelCase Convention Gap
- **Stories:** P0.7, P0.9, P1.1, P1.5, P1.11
- **Issue:** P0.7 API uses camelCase (agentId). P0.9 Hindsight schemas use snake_case (bank_id). P1.5 uses mixed (bank_id + taskBriefHash). No declared convention for JSON payloads at layer boundaries.
- **Severity:** MEDIUM across 5 stories

### CC-9: Observability Absent Across All Phase-0 Stories
- **Stories:** P0.3, P0.7, P0.9, P1.1, P1.3, P1.6
- **Issue:** No story specifies structured logging, request IDs, latency metrics, or timing breakdowns. P0.3 has coms-log but no schema. P0.7 has no MCP bridge observability. P0.9 has no bank operation logging. P1.1 has no A2A routing latency. P1.6 has no sub-timing.
- **Severity:** MEDIUM across 6 stories

---

## Findings Tables

### P0.3 — CLI-Anything Mixed-Model Demo

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P0.3-B1 | BLOCKER | exitClass→exitStatus verified (CC-1 Wave 0 fix complete, 4-value enum throughout) | ✅ DONE |
| P0.3-B2 | BLOCKER | Warren manifest-driven CLI verified (CC-2 Wave 0 fix, warren run --config .canopy/agent.json) | ✅ DONE |
| P0.3-B3 | BLOCKER | PI extensions + coms-net.ts API verified (CC-3 Wave 0 fix, 5-phase mapping table present) | ✅ DONE |
| P0.3-H1 | HIGH | P1.6 output schema `{status, filesChanged}` incompatible with P0.3 `{exitClass, changedFiles}` — no mapping defined | ✅ RESOLVED-BY-W0 (both stories now use `exitStatus` + `changedFiles` per CC-1/CC-4) |
| P0.3-H2 | HIGH | No concurrency test plan — race between coms_await timeout and worker completion untested | ✅ DONE (race-condition DoD item added) |
| P0.3-H3 | HIGH | Observability gap — coms log schema undefined, cost_events attribution absent | ✅ DONE (ComsLogEntry + CostEvent concrete schemas added to CC-9 section) |
| P0.3-M1 | MEDIUM | camelCase (story) vs snake_case (PRD) field naming — no mapping documented | ⬜ TODO |
| P0.3-M2 | MEDIUM | Missing signal-to-exitClass mapping table (PRD FR-MG-8 has it; story doesn't reference it) | ⬜ TODO |
| P0.3-M3 | MEDIUM | Graceful degradation for coms vendor absence not specified (socket-coms fallback to subprocess-RPC) | ⬜ TODO |
| P0.3-M4 | MEDIUM | Guard defaults ($0.50 budget, 5-turn cap) not sourced from PRD normative values | ⬜ TODO |
| P0.3-L1 | LOW | "Cuts CLI-Anything layer" — ambiguous verb ("exercises through" intended) | ⬜ TODO |
| P0.3-L2 | LOW | Model identifiers in E2E slice (glm-4, deepseek-chat) not marked as illustrative | ⬜ TODO |

### P0.7 — SwarmClaw Agent + MCP Hindsight

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P0.7-B1 | BLOCKER | Command allowlist expanded: +node, npx, node_modules/.bin path + SWARMCLAW_COMMAND_ALLOWLIST env var; AC5/DoD added | ✅ DONE |
| P0.7-B2 | BLOCKER | MCPInvokeArgumentsSchema added with BankIdSchema validation, -32602 on invalid bank_id, AC4 + DoD added | ✅ DONE |
| P0.7-H1 | HIGH | No graceful shutdown AC for stdio subprocess lifecycle (SIGTERM handling untested) | ✅ DONE |
| P0.7-H2 | HIGH | MCP tool enumeration staleness — no TTL or cache invalidation between /test and /invoke | ✅ DONE |
| P0.7-H3 | HIGH | "Standalone" label obscures downstream contract obligation to P0.9 (interface must remain stable) | ✅ DONE |
| P0.7-M1 | MEDIUM | camelCase (SwarmClaw API) vs snake_case (Hindsight tool args) — no convention note at MCP bridge boundary | ⬜ TODO |
| P0.7-M2 | MEDIUM | No observability for MCP bridge — no request IDs, timing, structured logging | ⬜ TODO |
| P0.7-M3 | MEDIUM | Invoke timeout 30s < P0.9 consolidate timeout 60s — P0.7 will kill P0.9's longest operation | ⬜ TODO |
| P0.7-M4 | MEDIUM | Max limits (32 MCP servers, 64 agents) stated but no AC/DoD tests enforcement | ⬜ TODO |
| P0.7-L1 | LOW | INV-SC4 (no network listeners) untestable in story scope — aspirational security | ⬜ TODO |
| P0.7-L2 | LOW | AC3 returns 502 for missing binary — 503 more semantically correct | ⬜ TODO |
| P0.7-L3 | LOW | INV-SC3 env allowlist (SWARMCLAW_ENV_ALLOWLIST) not enforced in schema or AC | ⬜ TODO |

### P0.9 — Hindsight Banks + Mulch

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P0.9-B1 | BLOCKER | JSONL declared canonical Mulch format; conversion pipeline for YAML/JSON→JSONL documented; AC6 + DoD updated | ✅ DONE |
| P0.9-B2 | BLOCKER | MulchExpertiseSchema extended with id/source fields; Schema Alignment Note mapping to P1.12 MulchEntry added | ✅ DONE |
| P0.9-B3 | BLOCKER | AC4 (MCP bridge unregistered → -32001) + AC5 (Hindsight binary unavailable → -32002) + DoD dependency failure test added | ✅ DONE |
| P0.9-H1 | HIGH | Idempotency dedup key underspecified — concepts array order-dependent for hashing; canonical form not stated | ✅ DONE |
| P0.9-H2 | HIGH | Mulch import partial failure behavior undefined — transactional vs best-effort? Per-entry status? | ✅ DONE |
| P0.9-H3 | HIGH | No performance AC for recall latency — 9.9s recall would pass AC1, making factory impractical | ✅ DONE |
| P0.9-H4 | HIGH | Consolidate operation has no observable success criterion — no schema, no "preserves it" definition | ✅ DONE |
| P0.9-H5 | HIGH | `.mulch/expertise/` directory traversal behavior underspecified — subdirectory recursion, non-YAML files | ✅ DONE |
| P0.9-M1 | MEDIUM | snake_case vs camelCase naming convention gap across P0.7→P0.9→P1.11 boundary | ⬜ TODO |
| P0.9-M2 | MEDIUM | No observability AC for bank operations (provision, import, round-trip logging) | ⬜ TODO |
| P0.9-M3 | MEDIUM | No ConsolidatePayloadSchema defined — request/response shape unknown | ✅ DONE |
| P0.9-M4 | MEDIUM | Hindsight version not pinned; P1.11 references pip 0.4.17 — version skew risk | ⬜ TODO |
| P0.9-M5 | MEDIUM | `{repo}` placeholder resolution undefined — no story defines repo slug → bank ID mapping | ⬜ TODO |
| P0.9-L1 | LOW | Mulch CLI v0.6.3 pinning — minimum vs exact version not stated | ⬜ TODO |
| P0.9-L2 | LOW | Hindsight REST API `/v1/default/` prefix stability assumption unnoted | ⬜ TODO |

### P1.1 — Dev Manager A2A Delegation

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P1.1-B1 | BLOCKER | Transport Contract added: local HTTP POST to localhost:3100/a2a, JSON-RPC envelopes, -32010 on connection refused, no subprocess fallback | ✅ DONE |
| P1.1-B2 | BLOCKER | A2A Error Code Taxonomy table added: 8 codes (-32600,-32601,-32602,-32000,-32010→-32013) with semantic realignment per transport contract | ✅ DONE |
| P1.1-H1 | HIGH | No AC verifying CLI-Anything harness actually receives forwarded request with correct body | ✅ DONE — AC5 + DoD forward-verification test added |
| P1.1-H2 | HIGH | Correlation ID propagation asserted but never specified — no field, generation, or propagation contract | ✅ DONE — Correlation ID Contract subsection added to Technical Notes |
| P1.1-H3 | HIGH | timeoutMs upper bound 300s < P1.6 maxDurationMs 600s — A2A layer preempts dispatch_task | ✅ DONE — Resolved by W0 CC-7; story already has 900s > 600s |
| P1.1-H4 | HIGH | onFailure retry policy has no max attempts, backoff, or idempotency key specified | ✅ DONE — Retry policy defaults subsection added to Technical Notes |
| P1.1-M1 | MEDIUM | agentType enum closed at 3 values — pivot has more roles; no note about expected widening | ⬜ TODO |
| P1.1-M2 | MEDIUM | No observability for A2A routing latency despite E2E slice requiring <5s | ⬜ TODO |
| P1.1-M3 | MEDIUM | No circuit breaker for repeated endpoint failures — noted as Phase 2 gap | ⬜ TODO |
| P1.1-M4 | MEDIUM | endpointUrl allows any host (SSRF risk) — should restrict to localhost in Phase 1 | ⬜ TODO |
| P1.1-M5 | MEDIUM | Registration schema divergence from P0.7 — P1.1 adds agentType+endpointUrl not in P0.7's RegisterAgentSchema | ⬜ TODO |
| P1.1-L1 | LOW | E2E latency "<5s" measurement methodology undefined (wall-clock? excludes network?) | ⬜ TODO |
| P1.1-L2 | LOW | a2a_delegate config fields (7 fields) have no Zod schema — credentialId undefined | ⬜ TODO |
| P1.1-L3 | LOW | Duplicate registration 409 response body not specified | ⬜ TODO |

### P1.3 — Seeds Decompose Mirror

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P1.3-B1 | BLOCKER | A2A Dispatch Contract added: Seeds registers as qds-seeds, a2a.delegate({targetAgentId:"qds-seeds"}) routing, AC4 + 2 DoD items | ✅ DONE |
| P1.3-B2 | BLOCKER | resolveBankId(repoSlug) verified — all {repo} references replaced (CC-6 Wave 0 fix confirmed), literal placeholder never used at runtime | ✅ DONE |
| P1.3-B3 | BLOCKER | Sanitization Contract added: 5 concrete rules (executable blocks, inline shell, HTML injection, preserve non-exec, passthrough), AC5/AC6 + 5 DoD test cases | ✅ DONE |
| P1.3-H1 | HIGH | No AC or DoD test for 20-story decomposition limit — load-bearing guard untested | ✅ DONE |
| P1.3-H2 | HIGH | Append-only JSONL has no compaction, rotation, or size-limit — grows unboundedly | ✅ DONE |
| P1.3-H3 | HIGH | Dependency-edge schema for Hindsight storage undefined — edges written but shape unknown | ✅ DONE |
| P1.3-H4 | HIGH | No error code enumeration for decompose failures (session not found, not intake, 0 stories, mirror all failed) | ✅ DONE (resolved by W1 B1 — Decompose Error Code Taxonomy already present) |
| P1.3-M1 | MEDIUM | Schema field naming inconsistency — storyPoints (camelCase) vs Hindsight metadata.kind values | ⬜ TODO |
| P1.3-M2 | MEDIUM | No observability for mirror latency or JSONL write time | ⬜ TODO |
| P1.3-M3 | MEDIUM | No deduplication if decompose called twice on same sessionId — would create duplicate JSONL entries | ⬜ TODO |
| P1.3-M4 | MEDIUM | .gitignore enforcement runtime-only — no CI check that .seeds/issues.jsonl is not tracked | ⬜ TODO |
| P1.3-L1 | LOW | FR-CP-3 spec reference unverifiable — may be stale pre-pivot reference | ⬜ TODO |
| P1.3-L2 | LOW | GitHub sub-issue linking mechanism lists two options ("body reference or sub-issue API") without selecting one | ⬜ TODO |
| P1.3-L3 | LOW | seedsId in mappings array — minor naming nit, consistent within story | ⬜ TODO |

### P1.4 — Protocol Template

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P1.4-B1 | BLOCKER | Phase-to-Extension Mapping table verified (CC-3 Wave 0 fix, 6 mappings including compare/decide→coms-net.ts) | ✅ DONE |
| P1.4-B2 | BLOCKER | Phase Algorithms section added: compare (Jaccard + test delta + semantic→ComparisonResult), decide (weighted scoring 0.5/0.3/0.2→DecisionResult), AC4/AC5 | ✅ DONE |
| P1.4-B3 | BLOCKER | Phase Config Binding section added: participantAgentIds→.canopy/agent.json, .pi/agents/ loaded by Warren, missing config→-32602, AC6 | ✅ DONE |
| P1.4-B4 | BLOCKER | AC7 added (unregistered agent→422 with -32013), DoD test for INV-3 coverage (registered+unregistered mix) | ✅ DONE |
| P1.4-H1 | HIGH | Template version 1.0.0 — no strategy for in-flight sessions when template updates mid-run (pin version? invalidate? informational?) | ✅ DONE — added Template Versioning subsection: immutable once registered, version pin at invocation, old versions retrievable but not invocable |
| P1.4-H2 | HIGH | Graceful degradation only tested 1-of-3 branch failure — 2-of-3 failure undefined (minimum branches for compare = ?) | ✅ DONE — added minimum-branches-for-compare rule: ≥1 branch required, all-fail produces empty ComparisonResult/DecisionResult, summarize reports complete failure |
| P1.4-H3 | HIGH | compare phase output schema is `output: any` — no comparison structure defined (per-branch summary? diff? recommendation?) | ✅ DONE — replaced output: any with typed union ComparisonResult | DecisionResult | Record<string,unknown> and cross-referenced Phase Algorithms section |
| P1.4-H4 | HIGH | decide phase has no scoring algorithm, no justification schema, no tie-breaking rule | ✅ DONE — added explicit tie-breaking rule: top-2 within 0.1 → tie:true, human review required, protocol engine pauses and emits tie_detected event |
| P1.4-H5 | HIGH | summarize phase output — no schema for final structured report (flat? nested? includes winning artifacts? links Hindsight?) | ✅ DONE — added summarize Phase Algorithm subsection with full schema: sessionId, templateId, phases[], finalResult{winner,summary,artifacts}, metadata{totalDurationMs,phaseCount,completedPhaseCount} |
| P1.4-H6 | HIGH | No PI extension loading strategy per phase — protocol engine has no mechanism to resolve phase `kind` to concrete PI executor | ✅ DONE — resolved by W0 CC-3 (Phase-to-Extension Mapping table) and W1 B1 (mapping verified). No edit needed |
| P1.4-M1 | MEDIUM | Phase output status missing "partial" state — parallel phase with degraded branches has no accurate status value | ⬜ TODO |
| P1.4-M2 | MEDIUM | No observability for per-phase timing metrics despite startedAt/completedAt fields in output schema | ⬜ TODO |
| P1.4-M3 | MEDIUM | Branch count limits (2-8) have no rationale — Warren resource limit? coms-net channel limit? arbitrary? | ⬜ TODO |
| P1.4-M4 | MEDIUM | Template registration auth has no RBAC — no differentiation between read (invoke) and write (register) access | ⬜ TODO |
| P1.4-L1 | LOW | Template schema uses `config: {...}` ellipsis for dispatch_task — should reference P1.6 for the config contract | ⬜ TODO |
| P1.4-L2 | LOW | Files to Modify lists 6 paths but DoD items imply more (schema validation, parallel error handler) | ⬜ TODO |
| P1.4-L3 | LOW | Template ID "qds-factory" has no validation rule (unlike P0.7's agentId regex) | ⬜ TODO |

### P1.6 — Pi-Team via Warren

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| P1.6-B1 | BLOCKER | exitStatus 4-value enum verified throughout (CC-1 Wave 0 fix complete, binary status fully eliminated) | ✅ DONE |
| P1.6-B2 | BLOCKER | Manifest-driven Warren CLI verified (CC-2 Wave 0 fix, all invocations use warren run --config, zero aspirational flags) | ✅ DONE |
| P1.6-H1 | HIGH | filesChanged path validation rejects ".." but not encoded traversals (%2e%2e, double-encoding, Unicode normalization) | ✅ DONE |
| P1.6-H2 | HIGH | Resource limits (2 CPU, 4GB) have no enforcement mechanism — Node.js child_process doesn't enforce these natively | ✅ DONE |
| P1.6-H3 | HIGH | Mulch priming from Hindsight bank has no AC for empty-bank case (fresh repo, first run) | ✅ DONE |
| P1.6-H4 | HIGH | pi-lens gating referenced but P0.5 scope is TDI diagnostics, not structured-JSON validation — scope mismatch | ✅ DONE |
| P1.6-H5 | HIGH | No error taxonomy for Warren exit codes — all non-zero treated as "failure", losing transient vs permanent distinction | ✅ DONE |
| P1.6-M1 | MEDIUM | filesChanged (P1.6) vs changedFiles (P0.3) — field name collision causes silent parse failure at runtime | ⬜ TODO |
| P1.6-M2 | MEDIUM | No sub-timing observability (Mulch priming, Warren burrow, Pi execution, pi-lens gating) | ⬜ TODO |
| P1.6-M3 | MEDIUM | No AC for concurrent dispatch_task steps from P1.4 parallel phase — Warren adapter concurrency undefined | ⬜ TODO |
| P1.6-M4 | MEDIUM | artifacts field in output schema has no validation (path relative? name unique? max count?) | ⬜ TODO |
| P1.6-L1 | LOW | maxDurationMs minimum 10s may be unrealistic given Mulch+Warren+Pi+pi-lens overhead | ⬜ TODO |
| P1.6-L2 | LOW | coverage field optional in testResults but no AC covers presence/absence; format (0-100 vs 0-1) undefined | ⬜ TODO |
| P1.6-L3 | LOW | .canopy/agent.json config layer silently skipped in execution chain — implicit work not covered | ⬜ TODO |

---

## Verified-Correct Elements

### P0.3
- Make-or-break AC binary and testable (`partial: false`, ≥2 distinct providers)
- Partial-failure AC correctly derived from PRD S4.6
- Security invariants (INV-1/2/3) aligned with PRD G4/NFR-SAF-1
- worker changedFiles enforcement (CORRECTNESS-C) matches PRD FR-EX-11
- Dependency edges correct (P0.1, P0.2)
- Files list scoped to 7 files, DoD story-specific

### P0.7
- agentId regex internally consistent after PR #17 fix
- agentId regex cross-story aligned with P1.1 (both `^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$`)
- E2E slice wiring-closed statement precise (3-layer: HTTP + MCP transport + Hindsight binary)
- Security invariants well-specified (INV-SC1 through SC5)
- AC3 negative path (binary not on PATH) is excellent — "never silently succeeds"
- File list realistic (9 files, each single responsibility)

### P0.9
- BankIdSchema regex well-constructed for path injection prevention
- Three-bank design internally consistent across P0.9, P1.3, P1.5, P1.11, P1.6
- Wiring-closed correctly scoped (depends only on P0.7, no circular dependency)
- Security invariants concrete and testable (INV-HM1 through HM4)
- E2E demo DoD strong — genuine end-to-end round-trip verification

### P1.1
- agentId regex aligned with P0.7 INV-SC1 — exact match
- Wiring-closed statement precise (no sibling dependency)
- JSON-RPC 2.0 envelope validation DoD correct
- Security invariants concrete (INV-1/2/3)
- AC3 unreachable-endpoint produces structured error (not 500 crash)
- Files list scoped to 5 files for 3-point story

### P1.3
- Authority split well-defined (Seeds owns decomposition, SwarmClaw/GitHub owns assignment)
- Append-only JSONL contract clear and consistently applied
- Best-effort mirror with partial failure handling correct
- Security invariants concrete (chmod 0600, scoped token, .gitignore)
- Dependency edges excluded from GitHub metadata — matches FR-MG-3
- Seeds story schema well-typed (mirroredIssueNumber nullable for partial failure)

### P1.6
- E2E slice well-formed with concrete demonstrable behavior
- Make-or-break AC binary and testable
- Failure AC (AC-3) specific with failure output schema + no-crash guarantee
- Security invariants present (repo scoping, path traversal, resource limits)
- DoD covers unit + mandatory e2e test
- File list reasonable (5 files, clear responsibilities)

### P1.4
- 5-phase flow matches canonical protocol in pivot architecture
- E2E slice well-defined: register template, invoke, verify 5 phase outputs
- Dependency edges correct (P0.7, P0.11)
- Security invariants present (INV-1 auth, INV-2 session scoping, INV-3 agent registration)
- Phase output schema includes phaseIndex, kind, status, startedAt, completedAt
- DoD includes unit tests + MANDATORY e2e demo
- Graceful degradation addressed in AC-3 (coverage incomplete but present)
- Template JSON branch model (participantAgentIds, facilitatorAgentId, observerAgentIds) reasonable
- Story point estimate of 4 proportionate

---

## Session Log

| Timestamp | Wave | Agent | Action | Notes |
|-----------|------|-------|--------|-------|
| 2026-06-09 15:03 | Init | parent | Tracker created | Round 7 post-pivot alignment review of 7 load-bearing stories |
| 2026-06-09 15:03 | Init | parent | Reviewers dispatched | 7 parallel reviewers (one per story) |
| 2026-06-09 ~16:30 | Init | parent | P0.7 collated | 12 findings (2B/3H/4M/3L). agentId regex confirmed fixed. Invoke timeout conflict with P0.9 flagged. |
| 2026-06-09 ~16:30 | Init | parent | P1.6 collated | 14 findings (2B/5H/4M/3L). exitClass conflict with P0.3 (BLK-1). Warren CLI surface gap (BLK-2). |
| 2026-06-09 ~16:45 | Init | parent | P0.9 collated | 15 findings (3B/5H/5M/2L). Mulch format/schema conflict with P1.12 (BLK-1/2). No P0.7-failure AC (BLK-3). |
| 2026-06-09 ~16:45 | Init | parent | P1.1 collated | 14 findings (2B/4H/5M/3L). A2A transport unspecified (BLK-1). No error codes (BLK-2). Timeout misalignment with P1.6 (H3). |
| 2026-06-09 ~17:00 | Init | parent | P0.3 collated | 12 findings (3B/3H/4M/2L). exitClass "success" contradicts PRD (BLK-1). Warren identity ambiguous (BLK-2). PI extensions unnamed (BLK-3). |
| 2026-06-09 ~17:00 | Init | parent | P1.3 collated | 14 findings (3B/4H/4M/3L). A2A method dispatch gap (BLK-1). {repo} placeholder unresolved (BLK-2). Sanitization vague (BLK-3). |
| 2026-06-09 ~17:30 | Init | parent | P1.4 collated | 17 findings (4B/6H/4M/3L). Phase kinds never map to PI extensions (BLK-1). compare/decide unspecified (BLK-2). No .canopy config (BLK-3). INV-3 untested (BLK-4). |
| 2026-06-09 ~17:30 | Init | parent | Initial Scan COMPLETE | **7/7 stories reviewed. 98 findings total: 19B / 30H / 30M / 19L.** 9 cross-cutting themes identified. Tracker fully populated. Ready for user review before Wave 0 dispatch. |
| 2026-06-09 ~15:55 | W0 | parent | Wave 0 dispatched | 7 parallel subagents (w0-p03/p07/p09/p11/p13/p14/p16). CC theme→story mapping: P0.3{CC-1,2,3,4,9}, P0.7{CC-7,8,9}, P0.9{CC-6,7,8,9}, P1.1{CC-5,7,8,9}, P1.3{CC-5,6,9}, P1.4{CC-3}, P1.6{CC-1,2,3,4,7,9}. |
| 2026-06-09 ~15:58 | W0 | parent | Wave 0 COMPLETE | **9/9 CC themes resolved. 0 new findings. 0 regressions.** Key decisions: exitStatus (4-value enum), manifest-driven Warren CLI, resolveBankId() for {repo}, timeout chains aligned, camelCase convention documented, observability contract added to all stories. |
| 2026-06-09 ~20:00 | W1 | parent | Wave 1 dispatched | 7 parallel subagents (w1-p03/p07/p09/p11/p13/p14/p16). 19 BLOCKERs assigned. |
| 2026-06-09 ~20:35 | W1 | parent | Wave 1 COMPLETE | **19/19 BLOCKERs resolved. 0 new findings. 0 regressions.** Breakdown: P0.3(3 verified W0 landed), P0.7(2 fixed: allowlist+typed args), P0.9(3 fixed: JSONL format, schema alignment, P0.7 failure ACs), P1.1(2 fixed: HTTP transport contract, error code taxonomy), P1.3(3 fixed: A2A dispatch contract, resolveBankId verified, sanitization contract), P1.4(4 fixed: mapping verified, compare/decide algorithms, .canopy binding, INV-3 AC), P1.6(2 verified W0 landed). Cross-cuts: P0.7→P0.9 BankIdSchema import dependency documented. P1.1→P1.3 a2a.delegate canonical method established. P0.9→P1.12 schema alignment contract documented. |
| 2026-06-09 ~22:05 | W2 | parent | Wave 2 dispatched | 7 parallel subagents (w2-p03/p07/p09/p11/p13/p14/p16). 30 HIGHs assigned. Pre-dispatch: 4 HIGHs identified as already-resolved (P0.3-H1 by W0 CC-1/4, P1.1-H3 by W0 CC-7, P1.3-H4 by W1 B1, P1.4-H6 by W0 CC-3+W1 B1). |
| 2026-06-09 ~22:15 | W2 | parent | Wave 2 COMPLETE | **30/30 HIGHs resolved. 1 bonus MEDIUM (P0.9-M3). 0 new findings. 0 regressions.** Breakdown: P0.3(1 resolved-by-W0 + 2 fixed: race DoD, ComsLogEntry/CostEvent schemas), P0.7(3 fixed: SIGTERM AC, tool cache TTL, downstream stability note), P0.9(5 fixed: dedup canonical form, partial failure handling, recall latency AC, ConsolidatePayloadSchema, directory traversal rules), P1.1(1 resolved-by-W0 + 3 fixed: forward-verify AC, correlation ID contract, retry policy defaults), P1.3(1 resolved-by-W1 + 3 fixed: 20-story truncation AC, JSONL size threshold, DependencyEdgeSchema), P1.4(1 resolved-by-W0/W1 + 5 fixed: template versioning, min-branches-for-compare, output schema typed union, tie-breaking rule, summarize algorithm+schema), P1.6(5 fixed: encoded-path decode-then-check, resource limits enforcement, empty-bank AC, pi-lens scope clarification, Warren exit code mapping). New cross-cuts: P0.9 ConsolidatePayloadSchema resolves P0.9-M3. P1.6 Warren exit code mapping establishes exitStatus mapping contract. |
