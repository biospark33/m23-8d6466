# Architecture Documentation Quality Fixes

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical contradictions, add session 12 implementation coverage, and clean up housekeeping issues identified by the architecture quality review.

**Architecture:** Three work streams executed sequentially: (1) fix contradictions in existing architecture docs, (2) add session 13 implementation artifacts for ADR-025–032, (3) housekeeping updates across all docs. Each stream produces independently committable changes.

**Tech Stack:** Markdown documentation, SQL schema references, YAML examples

---

## Chunk 1: Fix Critical Contradictions in Architecture Docs

### Task 1: Fix FR34 Enforcement Metadata Contradiction in PRD v4

The PRD v4 still references a non-existent `enforcement` YAML field in Superpowers skill files. ADR-013 (session 10 amendment) explicitly decided that enforcement metadata lives in the `description` field.

**Files:**
- Modify: `_bmad-output/planning-artifacts/prd-v4.md` (FR34 text + Superpowers Gate Integration domain section)

- [ ] **Step 1: Locate and update FR34 text**

Find FR34 in prd-v4.md. Replace references to "`enforcement` metadata in YAML frontmatter" with "`description` field of YAML frontmatter (which carries enforcement metadata per ADR-013)".

- [ ] **Step 2: Update Superpowers Gate Integration domain section**

Find the Domain-Specific Requirements > Superpowers Gate Integration section. Update the YAML example that shows a separate `enforcement` field with `hook_checks` array. Replace with an example showing enforcement metadata encoded in the `description` field. Update any text stating "`skills-core.js` library is extended to extract `enforcement` fields" to reflect the actual approach.

- [ ] **Step 3: Add reconciliation note**

Add a footnote or inline note: "Amended 2026-03-15: Aligned with ADR-013 Session 10 Amendment 2. Enforcement metadata is encoded in the skill `description` field, not a separate YAML frontmatter field."

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/planning-artifacts/prd-v4.md
git commit -m "$(cat <<'EOF'
Fix FR34 enforcement metadata contradiction with ADR-013

PRD v4 still referenced a non-existent `enforcement` YAML field in
Superpowers skill files. ADR-013 (session 10) decided enforcement
metadata lives in the `description` field. Updated FR34 text and
Superpowers Gate Integration domain section to match.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Fix Attribution Table Name Conflict

ADR-005 names the table `attribution_chain`. ADR-016 calls it `cost_events`. Standardize on `cost_events` (the name used in all subsequent flow examples and session 11).

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md` (ADR-005 section)

- [ ] **Step 1: Read ADR-005 section**

Read the ADR-005 section in architecture-v2.md. Find the reference to `attribution_chain` table name.

- [ ] **Step 2: Update ADR-005 table reference**

Replace `attribution_chain` with `cost_events` in the ADR-005 section. Add inline note: "(Renamed from `attribution_chain` to `cost_events` — see ADR-016 Section 16.2 for rationale)".

- [ ] **Step 3: Verify no other stale references**

Search architecture-v2.md for any other occurrences of `attribution_chain` and update them.

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Fix attribution table name conflict: attribution_chain -> cost_events

ADR-005 named the table attribution_chain but ADR-016 renamed it to
cost_events. All subsequent references used cost_events. Updated
ADR-005 to match.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fix Migration Tracking Table Name Conflict

Session 10 amendment says `_migrations`. ADR-020 says `schema_migrations`. Story 1.2 says `_migrations`. Standardize on `_migrations` (the name used in Story 1.2 and session 10).

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md` (ADR-020 section)

- [ ] **Step 1: Read ADR-020 section**

Find the `schema_migrations` reference in ADR-020.

- [ ] **Step 2: Update to `_migrations`**

Replace `schema_migrations` with `_migrations` in ADR-020. Add note: "(Standardized to `_migrations` per Session 10 Amendment 3 and Story 1.2)".

- [ ] **Step 3: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Fix migration table name: schema_migrations -> _migrations

ADR-020 said schema_migrations but Session 10 and Story 1.2 use
_migrations. Standardized on _migrations.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Fix Learning Records Dual Storage Ambiguity

ADR-015 Section 15.3 says "No YAML files for mutable performance state" but the State Ownership Model still lists `.qds/learnings/` YAML files. Clarify that `pipeline.db` is the source of truth and YAML files are write-once snapshots for git-based sharing.

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md` (State Ownership Model + ADR-015)

- [ ] **Step 1: Read both sections**

Read the State Ownership Model table and ADR-015 Section 15.3 in architecture-v2.md.

- [ ] **Step 2: Add clarification to State Ownership Model**

Update the "Raw learning records" row to clarify: "Written to both `.qds/learnings/` (YAML, write-once snapshots for git sharing, eventually consistent) AND `pipeline.db` `learning_records` table (source of truth for queries and aggregation). See ADR-015 Section 15.3."

- [ ] **Step 3: Add reconciliation note to ADR-015**

In ADR-015 Section 15.3, add: "Note: `.qds/learnings/` YAML files serve as write-once snapshots for cross-session git sharing. They are NOT the source of truth for queries — `pipeline.db` `learning_records` table is authoritative for all read operations. YAML files are a distribution mechanism, not a data store."

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Clarify learning records dual storage: pipeline.db is source of truth

State Ownership Model and ADR-015 appeared to contradict each other
on whether learning records live in YAML files or pipeline.db. Added
clarification: pipeline.db is authoritative for reads; YAML files are
write-once snapshots for git-based sharing.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Fix Gateway Host Binding Contradiction

ADR-009/011 say "never `0.0.0.0`" but ADR-024 correctly uses `0.0.0.0` for Docker. Add context-conditional language to ADR-009.

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md` (ADR-009 G5 and ADR-011 G1)

- [ ] **Step 1: Read ADR-009 G5 and ADR-011 G1**

Find the "never `0.0.0.0`" statements.

- [ ] **Step 2: Add Docker exception**

Update ADR-009 G5 to: "Bind gateway to `127.0.0.1` only in bare-metal deployments — never `0.0.0.0` outside containers. Docker deployments use `0.0.0.0` to allow container networking (see ADR-024 Section 5)."

Update ADR-011 G1 similarly.

- [ ] **Step 3: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Fix gateway host binding: add Docker exception to 0.0.0.0 prohibition

ADR-009/011 said 'never 0.0.0.0' but ADR-024 correctly uses 0.0.0.0
for Docker containers. Updated to context-conditional language.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: Session 13 Implementation Artifacts — Stories for ADR-025–032

### Task 6: Add Session 12 Stories to Epics and Stories Document

Add new stories covering ADR-025 through ADR-032. MVP stories are added to existing epics. Growth stories go to the Growth section.

**Files:**
- Modify: `_bmad-output/implementation-artifacts/epics-and-stories.md`

- [ ] **Step 1: Read current document structure**

Read the end of the document to understand the current Growth stories section and the version footer.

- [ ] **Step 2: Add MVP Story 1.7: pipeline.db Session 12 Schema Migration**

Add after Story 1.6 in Epic 1:

```markdown
### Story 1.7: pipeline.db Session 12 Schema Migration

**Description:** Add sequential SQL migration `002-session12-schema.sql` extending `story_runs` with 12 new columns and creating 6 new tables required by ADR-025 through ADR-032. This migration runs after the initial 001 migration (Story 1.2) and follows the same sequential SQL runner pattern.

**Acceptance criteria:**
- [ ] Migration file `factory-core/src/migrations/002-session12-schema.sql` adds all 12 `story_runs` columns: `disambiguation_score`, `disambiguation_passed`, `disambiguation_questionnaire_sent_at`, `disambiguation_resolved_at`, `blast_radius`, `blast_radius_signals`, `merge_mode_determined`, `merge_mode_override_reason`, `pr_auto_merged_at`, `intake_at`, `pr_created_at`, `lines_changed`, `complexity_band`, `rework_cause`, `caused_production_issue`, `cycle_time_seconds`, `pr_merged_at`
- [ ] Creates 6 new tables: `disambiguation_false_negatives`, `pr_confidence_records`, `pr_outcomes`, `pr_defect_classifications`, `story_wait_times`, `import_graph` with all CHECK constraints and indexes per ADR-025–032
- [ ] Migration is idempotent (re-runnable without error)
- [ ] Migration runner tests verify 002 migration applies cleanly after 001

**FR references:** FR172, FR178, FR179, FR180, FR181, FR183, FR187, FR190, FR192, FR193, FR191
**ADR references:** ADR-025, ADR-026, ADR-027, ADR-028, ADR-029, ADR-030, ADR-032
**Files created/modified:**
- `factory-core/src/migrations/002-session12-schema.sql` (~120 LOC)
**Estimated LOC:** 120
**Dependencies:** Story 1.2
**MVP/Growth:** MVP (schema foundation for both MVP and Growth features)
```

- [ ] **Step 3: Add MVP Story 4.8: Disambiguation Gate**

Add to Epic 4 (Turn Continuation & Hooks):

```markdown
### Story 4.8: Spec Disambiguation Gate (Intake Sub-Phase)

**Description:** Implement the disambiguation gate within the Intake phase per ADR-025. A spec-disambiguator agent (economy tier) evaluates story specs against a completeness checklist. Above-threshold specs proceed automatically; below-threshold specs pause for developer interaction via dashboard notification and Telegram.

**Acceptance criteria:**
- [ ] Disambiguation agent runs after FR91 structural validation, before `phase_transitions` write
- [ ] Uses `spec-disambiguator` Superpowers skill at economy tier
- [ ] Scores specs using the applicable-items algorithm (ADR-025)
- [ ] Above-threshold (default 0.80): logs score, sets `disambiguation_passed = 1`, advances to Develop
- [ ] Below-threshold: pauses story, sends questionnaire via dashboard notification and Telegram
- [ ] Developer response flow: appends answers to spec, re-runs disambiguation (max 2 rounds)
- [ ] Forced proceed option after round 2 failure
- [ ] Infrastructure failure (crash, malformed JSON, 30s timeout): logs warning, sets score/passed to NULL, proceeds to Develop
- [ ] Dashboard intake phase card shows disambiguation sub-indicator
- [ ] pipeline.db `story_runs` columns populated correctly

**FR references:** FR172
**ADR references:** ADR-025
**Files created/modified:**
- `factory-core/src/pipeline/disambiguation.ts` (~200 LOC)
- `factory-core/src/skills/spec-disambiguator.md` (~30 LOC)
**Estimated LOC:** 230
**Dependencies:** Stories 1.2, 1.7, 4.0
**MVP/Growth:** MVP
```

- [ ] **Step 4: Add MVP Story 4.9: Production-Readiness Gate Extensions**

Add to Epic 4:

```markdown
### Story 4.9: Dependency Hygiene and SAST Gate Scripts

**Description:** Implement two new Layer 4 gate scripts per ADR-026: `dependency-hygiene.ts` (FR178) and `sast-scan.ts` (FR179). Both run only at the DEVELOP-to-BMAD boundary and follow the ADR-010 stdin/stdout gate interface.

**Acceptance criteria:**
- [ ] `scripts/gates/dependency-hygiene.ts` implements ADR-010 gate interface (GateContext stdin, GateResult stdout, exit codes 0/1/2)
- [ ] Dependency hygiene: skips if no lockfile in changed_files, runs `bun audit --json` / `npm audit --json` / `cargo audit --json`, enforces 10s timeout, fails on critical/high CVE
- [ ] `scripts/gates/sast-scan.ts` implements ADR-010 gate interface
- [ ] SAST: checks for semgrep on PATH (advisory skip if missing), runs semgrep with configurable ruleset (default `p/owasp-top-ten`), enforces 15s timeout
- [ ] Both scripts registered for `develop_to_bmad` boundary only
- [ ] `FindingCategory` enum extended with `dependency_cve`, `dependency_stale`, `sast_owasp`
- [ ] `factory.yaml` schema extended with `quality.dependency_hygiene_enabled`, `quality.sast_enabled`, `quality.sast_tool`, `quality.sast_ruleset`
- [ ] Both checks run in the parallel group alongside lint/type-check (NFR3 ≤60s preserved)

**FR references:** FR178, FR179
**ADR references:** ADR-026, ADR-010
**Files created/modified:**
- `scripts/gates/dependency-hygiene.ts` (~80 LOC)
- `scripts/gates/sast-scan.ts` (~100 LOC)
- Modify: `shared-types/src/must-haves.ts` (FindingCategory enum, ~5 LOC)
- Modify: `factory-core/src/config.ts` (factory.yaml quality schema, ~10 LOC)
**Estimated LOC:** 195
**Dependencies:** Stories 1.1, 4.0
**MVP/Growth:** MVP
```

- [ ] **Step 5: Add MVP Story 5.7: Observer Dimension Extensions (MVP Dimensions)**

Add to Epic 5 (Performance Data Collection):

```markdown
### Story 5.7: Observer Dimension Extensions — Cycle Time, Rework Rate, PR Size

**Description:** Extend the FR77 daily observer with three MVP dimensions per ADR-032: cycle time by complexity band (FR180), rework rate with cause breakdown (FR191), and PR size distribution (FR183). Extend pipeline.db `story_runs` with `intake_at`, `pr_created_at`, `pr_merged_at`, `cycle_time_seconds`, `lines_changed`, `complexity_band`. Populate these columns from existing Factory Core event handlers.

**Acceptance criteria:**
- [ ] `intake_at` set when story enters pipeline, `pr_created_at` set at PR creation
- [ ] `cycle_time_seconds` computed at PR creation as `pr_created_at - intake_at`
- [ ] `complexity_band` set at intake: small (1-5 files), medium (6-20), large (>20)
- [ ] `lines_changed` computed from `git diff --stat` at PR creation
- [ ] `pr_size_warning` event emitted if lines_changed > configurable threshold (default 300)
- [ ] Daily observer computes rolling 30-day average cycle time per band with anomaly detection (1.5 SD)
- [ ] Daily observer computes rework rate with `ambiguity_caused_rate` (nullable until FR187 live)
- [ ] Daily observer computes PR size distribution: avg lines, % over threshold
- [ ] FR77 daily journal schema updated with dimensions 10, 11, 12 per ADR-032

**FR references:** FR180, FR183, FR191
**ADR references:** ADR-032
**Files created/modified:**
- Modify: `factory-core/src/pipeline/intake.ts` (~20 LOC additions)
- Modify: `factory-core/src/pr/create.ts` (~30 LOC additions)
- `factory-core/src/observer/dimensions/cycle-time.ts` (~50 LOC)
- `factory-core/src/observer/dimensions/rework-rate.ts` (~40 LOC)
- `factory-core/src/observer/dimensions/pr-size.ts` (~30 LOC)
**Estimated LOC:** 170
**Dependencies:** Stories 1.2, 1.7, 5.1
**MVP/Growth:** MVP
```

- [ ] **Step 6: Add Growth stories for ADR-027, 028, 029, 030, 031, 032 (Growth dimensions)**

Add to the Growth Stories section:

```markdown
### Growth Story: PR Confidence Score and Self-Assessment Accuracy (ADR-027)

**Description:** Aggregate per-phase confidence declarations into a PR-level composite score at PR creation time. Track predicted vs. actual outcomes via GitHub polling. Display self-assessment accuracy gauge on dashboard.

**FR references:** FR181, FR182, FR184
**ADR reference:** ADR-027
**Dependencies:** FR131 (Story 5.2), Story 1.7

### Growth Story: Blast Radius Scorer (ADR-028)

**Description:** Compute multi-signal blast radius score at story intake using downstream importer count, test coverage density, git churn x defect rate, and code age. Cache import graph in pipeline.db. Blast radius gates BMAD wave counts and merge policy.

**FR references:** FR192
**ADR reference:** ADR-028
**Dependencies:** Story 1.7

### Growth Story: Confidence-Gated Merge Policy (ADR-029)

**Description:** Implement three-mode merge governance (supervised/assisted/autonomous) with domain trust taxonomy in factory.yaml. ELO-gated autonomous mode per domain. Hard safety constraints for high blast radius and high rollback risk.

**FR references:** FR193, FR194
**ADR reference:** ADR-029
**Dependencies:** FR133 (ELO ratings), ADR-028 (blast radius), ADR-027 (rollback risk)

### Growth Story: Learning Loop Extensions (ADR-030)

**Description:** Extend learning record schema with `rework_cause` field. Add PR defect classification agent (economy tier, 7-category taxonomy). Extend daily observer with ambiguity-caused rate breakdown.

**FR references:** FR187, FR190
**ADR reference:** ADR-030
**Dependencies:** Story 7.1, Story 1.7

### Growth Story: Mulch Domain and Style Profile Extensions (ADR-031)

**Description:** Add `.mulch/domain/` and `.mulch/style/` subdirectories with YAML-structured domain invariants and style conventions. Extend overlay assembly Stage 3 to inject matched entries. Add `qds mulch add-domain` and `qds mulch add-style` CLI commands.

**FR references:** FR188, FR189
**ADR reference:** ADR-031
**Dependencies:** FR28a Stage 3 (overlay assembly)

### Growth Story: Observer Growth Dimensions — Defect Escape Rate and Parallelization Yield (ADR-032)

**Description:** Add `caused_production_issue` manual flag via `qds pr mark-production-issue` CLI command. Compute defect escape rate (90-day rolling). Track story wait times in `story_wait_times` table. Compute parallelization yield (utilization percentage). Add daily journal dimensions 13 and 14.

**FR references:** FR185, FR186
**ADR reference:** ADR-032
**Dependencies:** Story 5.7, Story 1.7

### Growth Story: Disambiguation Calibration Records (ADR-025 Growth)

**Description:** Track disambiguation false negatives: stories that passed disambiguation but later had `rework_cause = ambiguity`. Compute false-negative rate over 30-day window. Emit dashboard alert if rate exceeds 15%.

**FR references:** FR173
**ADR reference:** ADR-025
**Dependencies:** Story 4.8, Growth Story: Learning Loop Extensions (FR187)
```

- [ ] **Step 7: Commit**

```bash
git add _bmad-output/implementation-artifacts/epics-and-stories.md
git commit -m "$(cat <<'EOF'
Add session 13 stories for ADR-025 through ADR-032

4 new MVP stories: 1.7 (session 12 schema migration), 4.8
(disambiguation gate), 4.9 (dep hygiene + SAST gates), 5.7
(observer MVP dimensions). 7 new Growth stories covering PR
confidence, blast radius, merge policy, learning extensions,
Mulch profiles, observer growth dimensions, and disambiguation
calibration. Closes the session 12 implementation gap.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Update FR Coverage Matrix

**Files:**
- Modify: `_bmad-output/implementation-artifacts/epics-and-stories.md` (FR Coverage Matrix section)

- [ ] **Step 1: Add FR172–FR196 rows to the FR Coverage Matrix**

Append after the FR171 row:

```markdown
| FR172 | 4.8 | Covered |
| FR173 | Growth (Disambiguation Calibration) | Growth |
| FR178 | 4.9 | Covered |
| FR179 | 4.9 | Covered |
| FR180 | 5.7 | Covered |
| FR181 | Growth (PR Confidence) | Growth |
| FR182 | Growth (PR Confidence) | Growth |
| FR183 | 5.7 | Covered |
| FR184 | Growth (PR Confidence) | Growth |
| FR185 | Growth (Observer Growth Dimensions) | Growth |
| FR186 | Growth (Observer Growth Dimensions) | Growth |
| FR187 | Growth (Learning Loop Extensions) | Growth |
| FR188 | Growth (Mulch Extensions) | Growth |
| FR189 | Growth (Mulch Extensions) | Growth |
| FR190 | Growth (Learning Loop Extensions) | Growth |
| FR191 | 5.7 | Covered |
| FR192 | Growth (Blast Radius) | Growth |
| FR193 | Growth (Merge Policy) | Growth |
| FR194 | Growth (Merge Policy) | Growth |
| FR195 | N/A | Growth (deferred) |
| FR196 | N/A | Growth (deferred) |
```

- [ ] **Step 2: Commit**

```bash
git add _bmad-output/implementation-artifacts/epics-and-stories.md
git commit -m "$(cat <<'EOF'
Update FR coverage matrix with FR172-FR196 (session 12)

All 25 new FRs now have coverage: 5 MVP (FR172, FR178, FR179,
FR180, FR183, FR191), 18 Growth, 2 deferred.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Update ADR Exercise Matrix

**Files:**
- Modify: `_bmad-output/implementation-artifacts/epics-and-stories.md` (ADR Exercise Matrix section)

- [ ] **Step 1: Add ADR-025 through ADR-032 rows**

Append after the ADR-024 row:

```markdown
| ADR-025 | 1.7, 4.8, Growth (Disambiguation Calibration) | Epic 1, 4 + Growth |
| ADR-026 | 1.7, 4.9 | Epics 1, 4 |
| ADR-027 | 1.7, Growth (PR Confidence) | Epic 1 + Growth |
| ADR-028 | 1.7, Growth (Blast Radius) | Epic 1 + Growth |
| ADR-029 | Growth (Merge Policy) | Growth |
| ADR-030 | 1.7, Growth (Learning Loop Extensions) | Epic 1 + Growth |
| ADR-031 | Growth (Mulch Extensions) | Growth |
| ADR-032 | 1.7, 5.7, Growth (Observer Growth Dimensions) | Epics 1, 5 + Growth |
```

- [ ] **Step 2: Commit**

```bash
git add _bmad-output/implementation-artifacts/epics-and-stories.md
git commit -m "$(cat <<'EOF'
Update ADR exercise matrix with ADR-025 through ADR-032

All 8 session 12 ADRs now have exercising stories mapped.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Update Code-Lift Manifest for Session 12 Stories

**Files:**
- Modify: `_bmad-output/implementation-artifacts/code-lift-manifest.md`

- [ ] **Step 1: Read current manifest structure to understand format**

Read the manifest header and a few story entries to match formatting.

- [ ] **Step 2: Add session 12 story entries**

Append entries for Stories 1.7, 4.8, 4.9, and 5.7. These are primarily new-write stories with minimal code-lift:

```markdown
---

## Session 12 Additions (ADR-025 through ADR-032)

#### Story 1.7: pipeline.db Session 12 Schema Migration (120 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none) | — | — | NEW_WRITE | All schema is new. Follow patterns from Story 1.2's 001-initial-schema.sql for DDL conventions, CHECK constraints, and index naming. |

**Estimated LOC savings:** 0
**Net new LOC:** ~120

---

#### Story 4.8: Spec Disambiguation Gate (230 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| overstory | `src/sessions/store.ts` | ~10 | PATTERN_COPY | Agent spawn pattern with timeout enforcement. |
| superpowers | `skills-core.js` | ~5 | INTERFACE_CARRY | Skill description field reading pattern per ADR-013. |

**Estimated LOC savings:** ~15
**Net new LOC:** ~215

---

#### Story 4.9: Dependency Hygiene and SAST Gate Scripts (195 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none — ADR-010 gate interface) | — | — | PATTERN_COPY | Follow existing gate script pattern from ADR-010: GateContext stdin, GateResult stdout, exit codes 0/1/2. |

**Estimated LOC savings:** ~10 (gate interface boilerplate)
**Net new LOC:** ~185

---

#### Story 5.7: Observer MVP Dimensions (170 LOC)

| Source | File | LOC | Reuse Type | What to Lift |
|--------|------|-----|------------|-------------|
| (none) | — | — | NEW_WRITE | Follow existing observer dimension patterns from Story 5.1 for daily journal YAML writing and SQLite aggregation queries. |

**Estimated LOC savings:** ~10 (observer dimension boilerplate)
**Net new LOC:** ~160
```

- [ ] **Step 3: Update manifest header version**

Update version to 3.0, date to 2026-03-15, add "Session 12 ADR-025-032 story coverage" to source line.

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/implementation-artifacts/code-lift-manifest.md
git commit -m "$(cat <<'EOF'
Add session 12 stories to code-lift manifest (v3.0)

4 new MVP stories: 1.7, 4.8, 4.9, 5.7. Mostly new-write with
minimal code-lift. Updated version to 3.0.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Update Code-Lift Gap Analysis for Session 12

**Files:**
- Modify: `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md`

- [ ] **Step 1: Read current gap analysis structure**

Read the gap analysis to understand format and risk register structure.

- [ ] **Step 2: Add session 12 risk assessment section**

Append a new section:

```markdown
---

## 5. SESSION 12 RISK ASSESSMENT (ADR-025 through ADR-032)

**RISK-6: Disambiguation agent requires new Superpowers skill (`spec-disambiguator`) that does not yet exist.**
- Severity: IMPORTANT
- Story: 4.8
- Mitigation: Skill is new-write following existing skill patterns. No code-lift risk — purely new content. The skill's `description` field carries enforcement metadata per ADR-013 (session 10 resolution).
- Status: OPEN

**RISK-7: SAST gate (Story 4.9) depends on semgrep binary which may not be installed.**
- Severity: LOW
- Story: 4.9
- Mitigation: ADR-026 explicitly handles this — semgrep absence produces advisory warning, not a block. Gate script is self-contained.
- Status: OPEN (mitigated by design)

**RISK-8: Session 12 schema migration (Story 1.7) adds ~17 columns to `story_runs` via ALTER TABLE.**
- Severity: IMPORTANT
- Story: 1.7
- Mitigation: SQLite ALTER TABLE ADD COLUMN is safe and fast. Migration is idempotent. All new columns are nullable (no NOT NULL without defaults on existing rows). Follow Story 1.2 patterns.
- Status: OPEN

**RISK-9: Daily observer (Story 5.7) assumes `intake_at` column exists on `story_runs` — depends on Story 1.7 migration running first.**
- Severity: IMPORTANT
- Story: 5.7
- Mitigation: Story dependency chain: 1.7 → 5.7. Migration runner ensures 002 runs before observer queries execute. Add explicit dependency in story.
- Status: OPEN

**RISK-10: FR Coverage and ADR Exercise matrices were not updated for session 12 until this session 13 update.**
- Severity: MINOR (now resolved)
- Mitigation: Matrices updated in Tasks 7 and 8 of this plan.
- Status: RESOLVED
```

- [ ] **Step 3: Update gap analysis header**

Update version to 3.0, date to 2026-03-15, add session 12 to scope.

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/implementation-artifacts/code-lift-gap-analysis.md
git commit -m "$(cat <<'EOF'
Add session 12 risk assessment to gap analysis (v3.0)

5 new risks assessed for ADR-025-032 stories. 4 OPEN (mitigated),
1 RESOLVED. Updated version to 3.0.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 3: Housekeeping

### Task 11: Update Epics Document Version and Summary

**Files:**
- Modify: `_bmad-output/implementation-artifacts/epics-and-stories.md` (header and footer)

- [ ] **Step 1: Update header**

Update version to 3.0, add "Session 12 ADR-025-032 story coverage (4 MVP stories, 7 Growth stories)" to source line. Update "10 epics, ~66 stories" to reflect new count.

- [ ] **Step 2: Update footer**

Update the version footer to reflect session 13 additions.

- [ ] **Step 3: Update dependency chain**

Add dependency notes for new stories:
- Story 1.7 depends on 1.2
- Story 4.8 depends on 1.2, 1.7, 4.0
- Story 4.9 depends on 1.1, 4.0
- Story 5.7 depends on 1.2, 1.7, 5.1

- [ ] **Step 4: Commit**

```bash
git add _bmad-output/implementation-artifacts/epics-and-stories.md
git commit -m "$(cat <<'EOF'
Update epics document to v3.0 with session 13 metadata

Updated header, footer, dependency chain, and story count to
reflect 4 new MVP stories and 7 new Growth stories.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Accept Proposed ADRs and Fix FR Count

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md`

- [ ] **Step 1: Update ADR-015 through ADR-023 status from "Proposed" to "Accepted"**

Find each ADR header (ADR-015 through ADR-020 with "Proposed (Revised)" and ADR-021 through ADR-023 with "Proposed") and change to "Accepted".

- [ ] **Step 2: Fix FR count references**

Update line 76 from "129 FRs across 15 capability areas" to "196 FRs across 21 capability areas (FR1-FR171 in PRD v2, FR172-FR196 added in PRD v4)".

Update the validation section (line ~3183) from "All 160 FRs and 38 NFRs" to "196 FRs and 48 NFRs (10 security NFRs added in PRD v3)".

- [ ] **Step 3: Fix Vite version in prose**

Find "Vite 6" in the technology stack text and update to "Vite 7" to match the compatibility matrix.

- [ ] **Step 4: Fix project name to "QDS Factory"**

Find `project_name: 'QDS-Engineer-New'` and "QDS Engineer v2" references. Update to "QDS Factory" consistently.

- [ ] **Step 5: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Housekeeping: accept proposed ADRs, fix FR counts, project name

- ADR-015 through ADR-023: Proposed -> Accepted
- FR count: 129/160 -> 196 FRs across 21 capability areas
- NFR count: 38 -> 48 (includes 10 security NFRs)
- Vite 6 -> Vite 7 in prose (matches compatibility matrix)
- Project name standardized to QDS Factory

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: Add Deprecation Notices to v1 Files

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture.md` (add deprecation header)
- Modify: `_bmad-output/planning-artifacts/architecture-amendments-session8.md` (add deprecation header)

- [ ] **Step 1: Add deprecation header to architecture.md (v1)**

Prepend:

```markdown
> **DEPRECATED:** This document is superseded by `architecture-v2.md`. All content has been incorporated into the v2 document. Do not reference this file for implementation decisions.
```

- [ ] **Step 2: Add deprecation header to session 8 amendments**

Prepend:

```markdown
> **DEPRECATED:** These amendments have been incorporated into `architecture-v2.md`. Do not reference this file for implementation decisions.
```

- [ ] **Step 3: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture.md _bmad-output/planning-artifacts/architecture-amendments-session8.md
git commit -m "$(cat <<'EOF'
Add deprecation notices to superseded v1 architecture files

architecture.md and architecture-amendments-session8.md are
fully superseded by architecture-v2.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: Update CLAUDE.md FR Count

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update FR reference**

Find "171 FRs" and update to "196 FRs" (171 from PRD v2 + 25 from PRD v4).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
Update CLAUDE.md FR count: 171 -> 196

Reflects PRD v4 additions (FR172-FR196) from session 12.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: Add ADR-009 Supersession Note

ADR-009 decision text still says `Bun.serve()` even though ADR-011 amended it to Express.

**Files:**
- Modify: `_bmad-output/planning-artifacts/architecture-v2.md` (ADR-009 decision line)

- [ ] **Step 1: Add inline supersession note to ADR-009 decision**

Find the ADR-009 decision line that says `Bun.serve()` gateway. Add inline note: "**[Amended by ADR-011 G1: HTTP server is Express under Bun, not raw `Bun.serve()`. SSE streaming contract unchanged.]**"

- [ ] **Step 2: Commit**

```bash
git add _bmad-output/planning-artifacts/architecture-v2.md
git commit -m "$(cat <<'EOF'
Add ADR-011 supersession note to ADR-009 decision text

ADR-009 still said Bun.serve() but ADR-011 G1 amended the HTTP
server to Express. Added inline amendment note for clarity.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```
