# QDS Factory Code-Lift Manifest -- Validation Gap Analysis Report

**Version:** 2.1 (Session 13)
**Date:** 2026-04-11 (session 13 amendments)
**Scope:** Cross-reference of deep-dive source code findings against PRD v2, Architecture v2, and Epic/Story decomposition
**Session 10 status:** ALL 3 blockers resolved, 5 risks resolved, 10 story gaps amended, and 5 missing stories addressed (4 added, 1 consolidated).
**Session 13 additions:** 3 new ADRs (ADR-033 orchestrator re-confirmation, ADR-034 `@claude-flow/guidance` lift, ADR-035 hook engine dual-plane strategy), 1 new story (Story 1.7), 4 new risks opened (3 LOW-MEDIUM, 1 LOW — all mitigated at open-time), 14 session-12 invariant-vs-mechanism reclassifications to be tracked via Step 5 architecture-v2.md correction pass.
**Documents reviewed:**
- `_bmad-output/implementation-artifacts/epics-and-stories.md` (v2.0, Session 10; v2.1 with Story 1.7 inserted by Session 13)
- `_bmad-output/planning-artifacts/architecture-v2.md`
- `_bmad-output/planning-artifacts/architecture-v2-session10-amendments.md`
- `_bmad-output/planning-artifacts/architecture-v2-session11-twelve-factor.md`
- `_bmad-output/planning-artifacts/architecture-v2-session12-amendments.md` (new, Session 13)
- `_bmad-output/planning-artifacts/session12-ruflo-evaluation-findings.md` (new, Session 12 evidence base)

---

## 1. VALIDATED ASSUMPTIONS (things the docs got right)

**V-1. Pi SDK has no native tier concept -- architecture anticipated this correctly.**
Architecture v2 line 127 states: "If Pi SDK's API surface doesn't support tier directives as first-class concepts, Factory Core needs an adapter layer." The architecture handoff (session 3) explicitly marks this RESOLVED: "No discrete tiers. Tier-to-model mapping needed." The architecture anticipated the gap and planned for a mapping layer. This is correctly handled.

**V-2. `transformContext()` as the overlay injection point.**
Architecture v2 line 288 identifies `Agent.transformContext()` as the overlay injection integration point. The deep-dive confirms `transformContext` callback is indeed the mechanism for overlay injection. This is correctly documented and the middleware chain (Epic 2) architecture is designed to funnel overlay content through this callback.

**V-3. Pi SDK per-call `Usage.cost.total` is available.**
Architecture v2 line 39 notes "per-call `Usage { tokens, cost }` reporting" from Pi SDK. Story 6.4 (Cost Data Flow) correctly designs around receiving `Usage { tokens, cost }` from Pi SDK callbacks. The deep-dive confirms `Usage.cost.total` is available on every `AssistantMessage`. The cost data flow design is aligned with reality.

**V-4. `skills-core.js` import-as-is strategy (ADR-013).**
ADR-013 in architecture v2 lines 838-901 decides to import `skills-core.js` as a library with `.d.ts` type declarations. The deep-dive recommends IMPORT_AS_IS. This is fully consistent. The five exported functions and their type signatures are correctly documented.

**V-5. SSE client uses `fetch()` not `EventSource`.**
Architecture v2 line 271 identifies the ZeroClaw SSE client as "fetch-based parser, auto-reconnect, exponential backoff, auth headers." The deep-dive confirms SSE uses `fetch()` for auth header support. ADR-001 carries forward this fetch-based client. Dashboard stories implicitly use this approach since they inherit the ZeroClaw SSE transport plumbing.

**V-6. Six direct-copy files from ZeroClaw confirmed.**
ADR-001 (architecture v2 lines 310-316) lists exactly 6 files: `index.html`, `vite.config.ts`, `tsconfig.json`, `tsconfig.app.json`, `src/lib/sse.ts`, `src/lib/ws.ts`. The deep-dive confirms these as the carry-forward files. The architecture correctly scopes the fork boundary.

**V-7. Overstory overlay is template-based with `{{PLACEHOLDER}}` substitution.**
Architecture v2 line 279 documents: "Overlay is template-based (`{{PLACEHOLDER}}` substitution), 25+ placeholders, reads from `templates/overlay.md.tmpl`." This matches the deep-dive finding. The architecture correctly notes Factory Core's 6-stage composable pipeline is a NEW system that wraps `generateOverlay()` as one stage.

**V-8. PaperclipAI `claimedAt` as design inspiration for task checkout.**
Architecture v2 line 1633 cites PaperclipAI's `agent_wakeup_requests.ts` `claimedAt` atomic checkout pattern as design inspiration. Story 6.3 implements this as new-write SQLite code with UNIQUE constraint, not a direct transplant. This is consistent with the research repo philosophy (design inspiration, not code transplant).

---

## 2. CHALLENGED ASSUMPTIONS (things the docs got wrong or incomplete)

**C-1. Story 2.3 (Credential Middleware) says "injects API keys via Pi SDK configuration in beforeModel()" -- vague on mechanism.** **SESSION 10: RESOLVED.**

The acceptance criterion states: "beforeModel() configures Pi SDK with the appropriate API credentials for the current agent role without exposing keys in overlay text." The deep-dive reveals the actual mechanism is the `getApiKey` callback pattern in Pi, not a generic "configuration" call. ADR-008 says "programmatic constructor init" but does not mention the callback pattern specifically.

**Resolution (Session 10):** Story 2.3 AC rewritten to specify `getApiKey` callback mechanism. ADR-008 amended (see architecture-v2-session10-amendments.md, Amendment 1). Story 2.3 now reads: "beforeModel() registers a `getApiKey` callback with Pi SDK's Agent constructor that returns the appropriate API key for the agent's configured provider."

**C-2. Story 2.5 (Enforcement Middleware) assumes YAML frontmatter has an `enforcement` metadata field -- it does not exist in Superpowers source.** **SESSION 10: RESOLVED (BLOCKER-1).**

Story 2.5 line 240 says: "beforeModel() reads Superpowers skill files with `enforcement` metadata in YAML frontmatter." The deep-dive reveals Superpowers has only TWO frontmatter fields: `name` and `description`. There is no `enforcement` field. The `description` IS the enforcement metadata -- it contains triggering conditions and guard rules as natural language.

This is particularly confusing because the PRD v2 (lines 559-586) describes extending Superpowers with structured `enforcement` metadata, and says `skills-core.js` should be "extended to extract enforcement fields." But ADR-013 (architecture v2 line 873) says "No content validation of skill descriptions -- Superpowers owns skill quality. Factory Core consumes frontmatter as-is." These two documents contradict each other.

**Resolution (Session 10):** BLOCKER-1 resolved with Option A -- `description` IS enforcement metadata. Story 2.5 AC rewritten to read `description` field. ADR-013 amended (see architecture-v2-session10-amendments.md, Amendment 2). PRD FR34 reconciliation note added. No Superpowers code changes required.

**C-3. Overstory mail schema extension for `learning_report` -- no story covers this.** **SESSION 10: RESOLVED.**

Architecture v2 line 280 states: "Must extend schema for `learning_report` -- Overstory's migration system handles upgrades." The deep-dive confirms the mail system has 12 message types with a CHECK constraint. Adding `learning_report` requires a SQLite table-rebuild migration to update the CHECK constraint (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`), since SQLite does not support modifying existing CHECK constraints via `ALTER TABLE`. However, no story in the epics explicitly creates this migration. Story 3.3 uses Overstory mail to send drift warnings, and Stories 7.1/7.2 create learning records, but neither story includes the mail schema migration in its acceptance criteria or file list.

**Resolution (Session 10):** Story 1.6 (Overstory Schema Extensions) added. Consolidates ALL Overstory database schema changes: mail.db `learning_report` type, mail.db `phase` column, events.db `hook_result` type, events.db `health_state` type. Uses two migration strategies appropriate to each change: (1) Overstory's native probe-then-alter pattern (`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`) for new columns like `phase`, and (2) SQLite table-rebuild (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`) for CHECK constraint modifications (adding `learning_report`, `hook_result`, `health_state` to existing CHECK constraints). M-1 and M-4 resolved by this single story.

**C-4. Migration runner pattern may conflict with Overstory's existing migration approach.** **SESSION 10: RESOLVED.**

Story 1.2 says: "Migrations are plain SQL files executed sequentially by Factory Core at startup." The deep-dive reveals Overstory's `SessionStore` uses `bun:sqlite` with a specific pattern: `PRAGMA table_info` check before `ALTER TABLE`. This is an idempotent probe-then-alter pattern, not a sequential migration file pattern. If Factory Core's migration runner applies plain SQL files to Overstory's databases (like adding `learning_report` to mail.db), it must be compatible with Overstory's existing probe-based pattern.

**Resolution (Session 10):** Story 1.2 AC amended to explicitly scope migration runner to Factory Core databases ONLY. Story 1.6 handles all Overstory schema extensions using a dual migration strategy appropriate to each change type: (1) Overstory's native probe-then-alter pattern (`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`) for new column additions (e.g., `phase` column), and (2) SQLite table-rebuild (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`) for CHECK constraint modifications (e.g., adding `learning_report` to mail.db, `hook_result`, `health_state`, and `subsystem_error` to events.db), since SQLite does not support modifying existing CHECK constraints via `ALTER TABLE`. Architecture amendment (Amendment 3) adds Database Migration Ownership Boundaries table documenting which databases use which migration pattern. See also Story 1.6 and Amendment 3 for the full dual-strategy specification.

---

## 3. STORY-LEVEL GAPS

| Story ID | Gap Description | Severity | Recommended Fix | Session 10 Status |
|----------|----------------|----------|----------------|-------------------|
| **2.3** | Credential middleware says "Pi SDK configuration" but Pi's actual mechanism is a `getApiKey` callback. Acceptance criteria are too vague to be implementation-ready. | IMPORTANT | Rewrite AC to specify `getApiKey` callback mechanism. | **RESOLVED** — Story 2.3 AC rewritten |
| **2.5** | Says "reads enforcement metadata in YAML frontmatter" but no such field exists. Only `name` and `description` exist. | BLOCKING | Rewrite AC to read `description` field. | **RESOLVED** — BLOCKER-1, Option A. Story 2.5 AC rewritten |
| **2.1** | Middleware chain ordering could be misinterpreted as priority/weight system. | MINOR | Add AC clarifying strict ordering. | **RESOLVED** — Story 2.1 AC amended |
| **1.4** | No top-level orchestration loop connecting startup to turn continuation. | IMPORTANT | Add orchestration loop story. | **RESOLVED** — Story 4.0 added |
| **3.1** | must_haves parser does not name GSD Nyquist three-level verification. | MINOR | Add clarifying note. | **RESOLVED** — Story 3.1 AC amended |
| **3.4** | Full Nyquist does not mention goal-first verification. | MINOR | Add goal-first AC. | **RESOLVED** — Story 3.4 AC amended |
| **6.3** | Atomic task checkout lacks multi-process growth note. | IMPORTANT | Add claim-confirm growth note. | **RESOLVED** — Story 6.3 AC amended |
| **6.4** | Cost source should be Pi SDK `Usage.cost.total`, not recomputed (cross-cutting concern for Stories 6.1-6.4, AC amended in 6.4). | MINOR | Add explicit cost source AC. | **RESOLVED** — Story 6.4 AC amended |
| **9.x** | ZeroClaw adaptations not covered by any story. | IMPORTANT | Create Story 9.0 setup story. | **RESOLVED** — Story 9.0 added |

---

## 4. MISSING STORIES — ALL RESOLVED

**M-1. Overstory Mail Schema Extension Migration (BLOCKING)** — **SESSION 10: RESOLVED → Story 1.6**

No story creates the SQL migration to add `learning_report` to Overstory's mail message type CHECK constraint. This blocks Story 3.3 (drift warnings via mail), any future learning_report mail usage, and FR23/FR57.

**Resolution:** Story 1.6 (Overstory Schema Extensions) added. Consolidates all mail.db and events.db schema extensions into a single story using a dual migration strategy: (1) Overstory's native probe-then-alter pattern (`PRAGMA table_info` → `ALTER TABLE ADD COLUMN`) for new column additions (e.g., `phase` column in mail.db), and (2) SQLite table-rebuild (`CREATE new table` → `copy data` → `DROP old` → `RENAME new`) for CHECK constraint modifications (adding `learning_report` to mail.db, `hook_result` and `health_state` to events.db). Also addresses M-4.

**M-2. TierResolver / Model Mapping Module (IMPORTANT)** — **SESSION 10: RESOLVED → Story 2.9**

The architecture acknowledges Pi SDK has no native tier concept, but no story explicitly creates the `TierResolver` that maps Factory Core's tier directives (economy/standard/premium) to actual Pi SDK `Model<Api>` objects via `Agent.setModel()`.

**Resolution:** Story 2.9 (Pi SDK Tier-to-Model Mapping -- TierResolver) added. Implements `resolveModel(tier: string): Model<Api>`, startup validation via `ModelRegistry.find()`, `factory.yaml` tiers configuration section.

**M-3. Factory Core Main Orchestration Loop (IMPORTANT)** — **SESSION 10: RESOLVED → Story 4.0**

Story 1.4 creates the process skeleton (startup, config, DB init). Stories 4.1-4.7 create the turn continuation loop (per-phase orchestration). But no story creates the top-level orchestration loop.

**Resolution:** Story 4.0 (Factory Core Orchestration Loop) added. Implements poll-reconcile-dispatch pattern inspired by Symphony GenServer. Depends on 1.4, prerequisite for 4.1. Includes concurrent story limits, crash recovery, circuit breaker integration.

**M-4. Overstory EventType Extension for `hook_result`, `health_state`, and `subsystem_error` (MINOR)** — **SESSION 10: RESOLVED → Story 1.6**

ADR-010 H2 specifies extending Overstory's `EventType` CHECK constraint to include `hook_result`. ADR-023 adds `health_state`. Story 8.8 requires `subsystem_error` for subsystem health event logging. No story explicitly creates these schema migrations.

**Resolution:** Consolidated into Story 1.6 (Overstory Schema Extensions) alongside M-1. All three events.db CHECK constraint extensions (`hook_result`, `health_state`, `subsystem_error`) are covered in a single table-rebuild migration.

**M-5. ZeroClaw Carry-Forward Adaptation Story (MINOR)** — **SESSION 10: RESOLVED → Story 9.0**

The deep-dive provides an exact 4-item adaptation checklist for the 6 carry-forward files. No story in Epic 9 explicitly performs these adaptations.

**Resolution:** Story 9.0 (ZeroClaw Carry-Forward Adaptation) added. Covers all 4 adaptations: type contract replacement, auth path change, subprotocol rename, base path change. Prerequisite for all other Epic 9 stories.

---

## 5. RISK REGISTER — SESSIONS 10 + 11 RESOLVED, SESSION 13 RISKS MITIGATED AT OPEN-TIME

| Risk | Severity | Status | Resolution / Mitigation |
|------|----------|--------|------------|
| **RISK-1:** Superpowers `enforcement` field fiction | HIGH | **RESOLVED (S10)** | BLOCKER-1 Option A: `description` IS enforcement. Story 2.5 rewritten, ADR-013 amended |
| **RISK-2:** Missing orchestration loop | HIGH | **RESOLVED (S10)** | Story 4.0 added (poll-reconcile-dispatch, Symphony GenServer pattern) |
| **RISK-3:** Pi SDK credential mechanism misunderstood | MEDIUM | **RESOLVED (S10)** | Story 2.3 AC rewritten with `getApiKey` callback. ADR-008 amended |
| **RISK-4:** Overstory schema extensions uncovered | MEDIUM | **RESOLVED (S10)** | Story 1.6 added (consolidates all Overstory schema changes) |
| **RISK-5:** Migration runner pattern incompatibility | LOW-MEDIUM | **RESOLVED (S10)** | Story 1.2 AC amended (FC-only scope). Architecture Amendment 3 (ownership table) |
| **RISK-6:** Alpine ARM64 native binary incompatibility | HIGH | **MITIGATED (S11)** | Debian-based images mandated per ADR-024 Section 3 |
| **RISK-7:** `@claude-flow/guidance` license / upstream drift | LOW-MEDIUM | **MITIGATED at open-time (S13)** | License vendored via `factory-core/THIRD_PARTY_LICENSES.md` per ADR-034 Integration Decision 4. MIT confirmed (`_research-repos/ruflo/LICENSE` lines 1–21, Copyright 2024–2026 ruvnet). Ruflo is an active project (6,000+ commits, claude-flow v3.5 rebranded). Monitoring: quarterly re-index of `_research-repos/ruflo` + cypher diff against the lifted subset. Material compiler changes to `compiler.ts:28-50` rule syntax regexes are the highest-attention drift surface because of ADR-034 Integration Decision 1 (overstory overlay format adaptation). `factory-core/src/guidance/UPSTREAM_DELTA.md` tracks every `// QDS:` tagged edit for upstream-drift monitoring. |
| **RISK-8:** Ruflo evaluation re-litigation | LOW | **MITIGATED at open-time (S13)** | ADR-033 is scope-closed with explicit re-opening criteria. Future "should we swap orchestrator?" questions must reference ADR-033 + `session12-ruflo-evaluation-findings.md` and either (a) produce a new product invariant that overstory structurally cannot satisfy, (b) show a measured structural regression in overstory's relevant subsystems via fresh cypher queries, (c) demonstrate an alternative scoring ≥ 20 points higher on the same 135-point rubric with the same methodology, or (d) show a material change in ruflo's structural shape (e.g., ruflo growing worktree/tmux primitives). Re-opening on preference, authority, or framework fashion is explicitly out of scope. |
| **RISK-9:** Story 1.7 scope creep through compiler adaptation | LOW-MEDIUM | **MITIGATED at open-time (S13)** | Story 1.7's spike phase (day 3) includes an explicit budget check: **"if the compiler adaptation requires > 400 LOC of rework, raise an exception to the user before continuing."** This is a forced decision point that prevents the spike from silently growing into a rewrite. If triggered, the budget exception surfaces the trade-off explicitly (ADR-034 Integration Decision 1 Option A vs Option B) rather than absorbing scope silently. Story 1.7's MVP scope is explicitly bounded at tier 1 + adapter (~7,422 LOC); tier-2 promotions from the spike land in a follow-on story, not Story 1.7. |
| **RISK-10:** Invariant-vs-mechanism conflation in existing ADRs | LOW-MEDIUM | **MITIGATED at open-time (S13)** | Session 12 Part A identified 11 items previously written into ADRs 001–023 as if architectural that are actually implementation-choice mechanisms overstory provides (tmux, git worktrees specifically, 6-layer hook taxonomy names, SQLite specifically, mail.db, TDD file-pair, 6-database split, action-scoring heuristic, observer/optimizer cadence, 50%/8K context budget, ELO). Step 5 of session 13 performs a targeted correction pass on `architecture-v2.md` (3,463 lines, 99 conflation candidates identified via grep) to tag conflation sites in-place without rewriting the document. Story acceptance criteria that reference a mechanism should be read as "using overstory's current mechanism for X" — the QDS invariant is X, not the mechanism. Future ADR authors must distinguish "the factory must" (invariant) from "overstory provides this by" (mechanism) per the ADR-033 guidance. |

**Session 13 risks summary:** 4 new risks (RISK-7, RISK-8, RISK-9, RISK-10), all mitigated at open-time by the ADRs that introduced them. None are blocking. RISK-7 has a recurring quarterly monitoring action. RISK-8 has a scope-closure rule that shuts down re-litigation without new evidence. RISK-9 has a forced budget-check inside Story 1.7's spike phase. RISK-10 has a targeted correction pass (Step 5) plus a go-forward convention for future ADR authors.

---

## 6. SESSION 13 ADDITIONS — ADR-033, ADR-034, ADR-035

Session 13 formalized the orchestrator re-evaluation from session 12 findings into three authoritative ADRs and one new MVP story. Unlike sessions 10 and 11 (which resolved existing gaps), session 13 **introduced new scope** driven by bias-stripped structural re-analysis. This section tracks that new scope.

### ADR-033: Orchestrator Re-Confirmation (overstory retained, scope-closed)

**Scope:** 10 hard invariants re-derived from PRD v2 alone (not from existing ADRs), 11 items reclassified from "architectural" to "implementation-choice mechanism", 135-point rubric scoring overstory at 90, ruflo at 54, build-fresh at 10 (9-of-10 invariants won by overstory). Rubric weights are criticality-derived and are themselves invariant per the re-opening criteria.
**New stories:** None (this ADR closes a question, it does not open work).
**Impact on existing stories:** None (overstory remains the base; the change is that overstory's identity as the base is now formalized and scope-closed rather than implicit in biased ADRs).
**Artifact updates:** `architecture-v2.md` requires a targeted correction pass in Step 5 to tag invariant-vs-mechanism conflation sites.

### ADR-034: `@claude-flow/guidance` Lift into Factory Core

**Scope:** Tiered extraction of 32 files from `_research-repos/ruflo/v3/@claude-flow/guidance/src/` (22,349 LOC source, ~19,438 LOC test). Tier 1 = full lift, 12 files, ~6,922 LOC. Tier 2 = spike-then-decide, 9 files, ~9,390 LOC (spike evaluates up to 3). Tier 3 = defer to post-MVP, 8 files, ~5,322 LOC. Tier 4 = drop, 2 files, ~1,250 LOC. Tier 5 = replace with QDS-specific adapter, 1 file (`hooks.ts` 465 LOC), ~500 LOC new write. 4 integration decisions specified: rule syntax alignment (adapt compiler to overstory overlay format per Option B), hook adapter target (ADR-035), test framework (adapt to `bun test` from vitest), license vendoring (`factory-core/THIRD_PARTY_LICENSES.md` manifest).
**New stories:** Story 1.7 (`@claude-flow/guidance` Lift Spike + Tier-1 Integration, ~7,422 LOC MVP). 3-day spike + constrained implementation. Blocked by 1.4, 1.5, and ADR-035 acceptance. Blocks Story 4.x phase-boundary enforcement and Story 8.x quality gate enforcement.
**Impact on existing stories:** None (Story 1.7 is additive). Story 2.5 (Enforcement Middleware) and Story 2.6 (Skill Middleware) remain unchanged — ADR-013 / Superpowers `description` field handling is complementary to ADR-034's guidance lift, not replaced by it.
**Artifact updates:** `code-lift-manifest.md` Section 1 Epic 1 gets Story 1.7 entry, Epic 1 subtotals updated, Section 2 reuse totals updated (project-wide reuse percentage jumps from 31.4% to 64.5% because ~6,922 LOC of the new scope is code-lift rather than new-write), Section 3 gets 4 new critical decisions (#11 overstory scope-closed, #12 invariant-vs-mechanism reclassification, #13 guidance is the cleanest lift in ruflo, #14 hooks package is NOT lifted), Section 5 Phase 1 gets Story 1.7 as implementation order #7.

### ADR-035: Hook Engine Strategy — Dual-Plane (overstory edge + Factory Core in-process)

**Scope:** Establishes that overstory's `src/agents/hooks-deployer.ts` (606 LOC POSIX shell script generator) and ruflo's `@claude-flow/hooks` (10,925 LOC TypeScript in-process hook engine) are **not two implementations of the same thing** — they operate at different runtime layers. Decision: dual-plane architecture. Overstory's edge plane is unchanged (reused as-is via `ov hooks install` at worker spawn time). Factory Core builds a ~400 LOC clean-room in-process plane (`factory-core/src/hooks/`) with concepts borrowed from ruflo's hooks design (priority registration, timeout wrap, pre/post event pairs, typed result aggregation) but zero lifted code. The two planes coordinate via Factory Core's pipeline engine — in-process results via `registry.execute(event, context)`, edge-plane results via `events.db` `hook_result` EventType (already covered by Story 1.6). In-process plane is **instance-based per story**, not a global singleton, enforcing invariant 1 (context isolation) at the hook-registry layer.
**New stories:** None. The ~400 LOC in-process hook engine is built inside Story 1.7's adapter phase as a prerequisite for the tier-5 adapter (which must bind against a hook engine). If Story 1.7's scope grows beyond its 3-day spike + adapter budget, a follow-up Story 1.8 for the hook engine as a standalone deliverable can be split out — but the split requires measured evidence from the spike, not pre-emptive scope carving.
**Impact on existing stories:** Story 1.7 carries this ADR's implementation. ADR-010 (6-layer hook pipeline in `architecture-v2.md`) is not replaced — it is reframed as "invariant = gated mechanical verification at phase boundaries; mechanism = dual-plane edge scripts + in-process engine coordinated by the pipeline." The count "6 layers" is organizational, not architectural, per session 12 Part A reclassification.
**Artifact updates:** `architecture-v2.md` ADR-010 gets a cross-reference to ADR-035 in Step 5. No changes to stories in Epic 4, Epic 8, or elsewhere — those stories consume the hook engine, they do not specify its internals.

### New Story Count

| Session | New Stories Added | Story IDs |
|---|---|---|
| Session 10 | 4 | 1.6, 2.9, 4.0, 9.0 |
| Session 11 | 2 | 1.4b, 1.4c (+ 5 growth stories backlog) |
| Session 13 | 1 | 1.7 |
| **Post-S13 MVP story count** | **~71** | (~64 original + 7 added across sessions 10/11/13) |

**LOC budget evolution:**

| Session | Project MVP LOC | Reusable LOC | Net New LOC | Reuse % |
|---|---:|---:|---:|---:|
| Original planning | 6,470 | 1,630 | 4,840 | 25.2% |
| Session 10 (adjusted) | 6,470 | 2,032 | 4,438 | 31.4% |
| Session 11 (no LOC change, operational) | 6,470 | 2,032 | 4,438 | 31.4% |
| **Session 13** | **13,892** | **8,954** | **4,938** | **64.5%** |

The session-13 jump is driven entirely by Story 1.7's ~7,422 LOC scope introduction. The net-new LOC only grows by ~500 (tier-5 adapter + hook engine net after compiler adaptation offset) — the bulk of Story 1.7 is lifted code, not new-write.

---

## Summary Statistics

| Category | Count | Status (through Session 13) |
|----------|-------|-------------------|
| Validated Assumptions | 8 | Confirmed (S9b) |
| Challenged Assumptions | 4 | **4/4 RESOLVED** (S10) |
| Story-Level Gaps | 10 | **10/10 AMENDED** (S10, 9 AC amendments + 1 via new story) |
| Missing Stories (S9b → S10) | 5 | **5/5 ADDRESSED** (S10, 4 added: 1.6, 2.9, 4.0, 9.0; M-4 consolidated into M-1 via 1.6) |
| New Stories (S11) | 2 + 5 growth | 1.4b, 1.4c + growth backlog |
| New Stories (S13) | 1 | **1.7** (`@claude-flow/guidance` lift per ADR-034) |
| Risks S9b / S10 | 5 | **5/5 RESOLVED** (2 HIGH, 2 MEDIUM, 1 LOW-MEDIUM) |
| Risks S11 | 1 | **1/1 MITIGATED** (RISK-6 Alpine ARM64 → Debian mandated) |
| Risks S13 | 4 | **4/4 MITIGATED at open-time** (RISK-7 license/drift, RISK-8 re-litigation, RISK-9 scope creep, RISK-10 conflation) |

**Blocking items:** ZERO. All historical blockers resolved (S10); no new blockers introduced by S13. Session 13 added new scope (Story 1.7, ~7,422 LOC) but did not introduce new dependencies that block existing stories — Story 1.7 depends on the existing 1.4 + 1.5 foundation and is a prerequisite for enforcement-dependent stories in Epic 4 and Epic 8 that had previously lacked a mechanical enforcement layer.

**Implementation readiness:** All documents amended through Session 13 are implementation-ready with zero ambiguity. Every acceptance criterion in Story 1.7 references the actual ruflo file paths, LOC counts, and MIT license location directly. Zero contradictions between PRD, architecture, and epics within the S10/S11/S13 scopes. Zero orphan dependencies. **Session 13 specifically:** Story 1.7 names its source files individually with per-file LOC and reuse classification, cites ruflo commit `b395d12` as the lift point, cites overstory commit `7872d54` as the integration target, and provides a 3-day spike plan with an explicit budget-check at day 3 that prevents silent scope creep.

**Session 13 pending actions (tracked as Step 5 of session 13, not blockers):**

1. `architecture-v2.md` targeted correction pass — tag invariant-vs-mechanism conflation sites in-place, surgical edits only, no rewrite. 99 candidate lines identified via grep (`tmux|worktree|mail\.db|6-layer|file-pair|SQLite`).
2. `architecture-v2.md` ADR index section update — add ADR-033, ADR-034, ADR-035 references pointing to `architecture-v2-session12-amendments.md`.
3. `architecture-v2.md` ADR-010 (hook pipeline) cross-reference to ADR-035 for the dual-plane architecture reframing.

These pending actions are scoped, sequential, and do not introduce new risk surface.

---

*v2.1 — Updated by Session 13. v2.0 updated by Session 10 resolution. Original generated by Wave 2 Gap/Risk Validator agent (Session 9b). All findings resolved or mitigated with explicit amendments, new stories, and design decisions across S10, S11, S13.*
