# Architecture v2.0 — Session 12 Amendment Notes (Gap Analysis Response)

**Date:** 2026-03-15
**Scope:** ADR-025 through ADR-032 — 8 new Architecture Decision Records responding to the autonomous factory success factors gap analysis. These amendments are authoritative and supersede any contradictory text in architecture-v2.md or prior session amendments regarding spec disambiguation, production-readiness gates, PR confidence scoring, blast radius scoring, merge governance, learning taxonomies, Mulch domain knowledge, and observer metrics.

**Gap Analysis Source:** `_bmad-output/planning-artifacts/gap-analysis-prd-v3-vs-success-factors-2026-03-15.md`
**PRD FRs Addressed:** FR172–FR196

## ADR Summary Table

| ADR | Title | Status | Phase | FRs |
|-----|-------|--------|-------|-----|
| ADR-025 | Disambiguation Phase Architecture | Accepted | MVP + Growth | FR172, FR173 |
| ADR-026 | Production-Readiness Gate Extensions | Accepted | MVP | FR178, FR179 |
| ADR-027 | PR-Level Confidence Score and Self-Assessment Accuracy | Accepted | Growth | FR181, FR182, FR184 |
| ADR-028 | Blast Radius Scorer Architecture | Accepted | Growth | FR192 |
| ADR-029 | Confidence-Gated Merge Policy and Domain Trust | Accepted | Growth | FR193, FR194 |
| ADR-030 | Learning Loop Extensions | Accepted | Growth | FR187, FR190 |
| ADR-031 | Mulch Domain and Style Profile Extensions | Accepted | Growth | FR188, FR189 |
| ADR-032 | Observer Dimension Extensions | Accepted | MVP + Growth | FR180, FR183, FR185, FR186, FR191 |

## Sprint 0 Prerequisite Updates

The following existing Sprint 0 prerequisite artifacts must be updated before implementation:

1. **FR77 Daily Journal Schema** — must be extended with 5 new dimensions (cycle_time, rework_rate, pr_size_distribution, defect_escape_rate, parallelization_yield) before any observer or dashboard implementation begins. See ADR-032 for complete schema.
2. **pipeline.db Migration Sequence** — the following new columns and tables must be added to the sequential migration plan (per ADR-003): `story_runs.disambiguation_score`, `story_runs.disambiguation_passed`, `story_runs.blast_radius`, `story_runs.blast_radius_signals`, `story_runs.merge_mode_determined`, `story_runs.pr_auto_merged_at`, `story_runs.intake_at`, `story_runs.pr_created_at`, `story_runs.lines_changed`, `story_runs.complexity_band`, `story_runs.rework_cause`, `story_runs.caused_production_issue`; new tables: `disambiguation_false_negatives`, `pr_confidence_records`, `pr_outcomes`, `pr_defect_classifications`, `story_wait_times`, `import_graph`.

---

# Architecture Decision Records: ADR-025 and ADR-026

**Author:** Winston (System Architect)
**Date:** 2026-03-15
**Session:** Planning — FR172, FR173, FR178, FR179

---

## ADR-025: Disambiguation Phase Architecture

**Status:** Accepted
**Scope:** MVP (FR172) + Growth (FR173)
**Affects:** Factory Core (`packages/factory-core/src/pipeline/intake.ts`), `pipeline.db` schema, dashboard, Telegram integration, overlay assembly

---

### Context

The factory pipeline currently accepts story spec files at Intake (FR1) and performs a structural schema validation (FR91) before advancing to the Develop phase. Experience shows that structurally valid specs can still be semantically incomplete — missing acceptance criteria, undeclared file scope, absent error-handling strategy — causing ambiguity-driven rework mid-development. Rework is expensive: it wastes builder agent tokens, burns developer attention, and pollutes the FR187 causal record with avoidable entries. A lightweight disambiguation gate at Intake can catch the majority of these cases before a single development token is spent.

---

### Decision

Inject a spec disambiguation agent step at the END of the Intake phase, after FR91 structural validation passes, before the `phase_transitions` record is written to advance to Develop. This step is a **gate within Intake** — it is not a new numbered pipeline phase.

The disambiguation agent runs at economy tier, launched via Overstory under the `spec-disambiguator` Superpowers skill. It receives the story spec YAML, a codebase summary from `.mulch/` scoped to the declared file scope, and a work-type-specific completeness checklist. It returns a structured score and per-item evidence. Factory Core acts on the score: above threshold, proceed; below threshold, pause and query the developer.

---

### Rationale: Sub-Phase of Intake, Not a New Pipeline Phase

The 5-phase model (Intake → Develop → BMAD Review → QA Swarm → Ship) is the unit of measurement for all downstream tracking. Phase counts appear in: pipeline.db `phase_transitions` records, NFR3 timing budgets, dashboard phase indicators, and every metrics query that asks "how long did phase N take?". Adding a 6th phase would:

1. Break all existing phase-count assertions in tests and queries.
2. Force NFR3 budget calculations to be re-derived for a phase that has no fixed duration (disambiguation round-trips are human-gated).
3. Misrepresent the pipeline semantics — disambiguation is a quality gate on the incoming spec, not a production step that transforms code.

Treating it as a gate step within Intake correctly communicates its nature: it is a precondition check that must pass before Intake is considered complete, exactly as FR91 structural validation is.

---

### Pipeline Position

```
FR1: Story spec files submitted
        ↓
FR91: Structural schema validation (ajv, existing)
        ↓  (pass only)
FR172: Disambiguation gate (new, sub-step of Intake)
        ↓  (score ≥ threshold OR developer resolved)
phase_transitions: Intake → Develop written to pipeline.db
        ↓
Develop phase begins
```

The disambiguation gate does not appear as a phase in `phase_transitions`. It is recorded as a separate set of columns on the `story_runs` record (see schema below).

---

### Disambiguation Agent Specification

**Model tier:** Economy (e.g., GLM-5 or equivalent economy-tier model as resolved by Pi SDK tier directive).

**Superpowers skill:** `spec-disambiguator`. The skill's `description` field carries enforcement metadata per ADR-013: the agent MUST respond with the structured checklist JSON and MUST NOT produce free-form prose as the primary output.

**Agent input (overlay assembly):**

| Input | Source | Notes |
|---|---|---|
| Story spec YAML | `story_runs.spec_path` | Full spec as submitted |
| Codebase summary | `.mulch/` scoped to `file_scope` in spec | If `file_scope` is absent, full `.mulch/` summary |
| Completeness checklist | Work-type-specific template (inline in system prompt) | Items vary by work type: `feature`, `bug`, `refactor`, `migration` |

**Completeness checklist items (universal):**

1. Explicit acceptance criteria (at least one testable criterion)
2. File scope declared (`files_in_scope` or `packages_in_scope` non-empty)
3. Error handling specified (what happens on each foreseeable failure path)
4. Test strategy explicit (unit/integration/e2e, which scenarios)
5. Dependency interaction described (which other components/services are touched)

**Completeness checklist items (conditional):**

6. Migration strategy (applicable when `file_scope` includes any `*.sql`, `migrations/`, or ORM model file)
7. API contract specified (applicable when `file_scope` includes route handlers or public SDK exports)
8. Rollback plan (applicable when `work_type = migration` or `breaking_change: true` in spec)

**Scoring algorithm:**

```
applicable_items = [item for item in checklist if applicable(item, spec, file_scope)]
present_items    = [item for item in applicable_items if agent returns present: true]
score            = len(present_items) / len(applicable_items)
```

Items flagged `not_applicable` by the agent (with evidence string explaining why) are excluded from the denominator. Score is a float in `[0.0, 1.0]`.

**Agent response schema (per item):**

```json
{
  "item": "string (checklist item identifier)",
  "applicable": true,
  "present": false,
  "evidence": "string (quote from spec proving presence, or explanation of absence)"
}
```

The full response is a JSON array of these objects. Factory Core validates this array before computing the score.

---

### pipeline.db Schema Extension

Extend the `story_runs` table with the following columns. Migration runs via Story 1.2 sequential SQL migration:

```sql
ALTER TABLE story_runs ADD COLUMN disambiguation_score REAL;
ALTER TABLE story_runs ADD COLUMN disambiguation_passed INTEGER;  -- 0/1 boolean, nullable
ALTER TABLE story_runs ADD COLUMN disambiguation_questionnaire_sent_at TEXT;  -- ISO8601, nullable
ALTER TABLE story_runs ADD COLUMN disambiguation_resolved_at TEXT;  -- ISO8601, nullable
```

`disambiguation_score` is `NULL` when disambiguation was skipped due to agent infrastructure failure (see Failure Handling below). `disambiguation_passed` is `NULL` in the same case.

---

### Above-Threshold Flow (Score ≥ `intake.disambiguation_threshold`)

1. Factory Core logs score to `story_runs.disambiguation_score`.
2. Sets `story_runs.disambiguation_passed = 1`.
3. Advances to Develop: writes `phase_transitions` record.
4. Zero developer interaction. Stories with well-specified specs incur no friction.

Default threshold: `0.80` (80% of applicable items present). Configurable via `factory.yaml`:

```yaml
intake:
  disambiguation_threshold: 0.80
```

---

### Below-Threshold Flow (Score < `intake.disambiguation_threshold`)

1. Factory Core sets `story_runs.disambiguation_passed = 0`, records score.
2. Sends disambiguation questionnaire to developer via two channels (in parallel):
   - **Dashboard notification:** type `disambiguation_required`, payload `{ story_id, score, missing_items: string[] }`.
   - **Telegram** (if configured in `factory.yaml`): message listing missing items with instructions.
3. Sets `story_runs.disambiguation_questionnaire_sent_at` to current ISO8601 timestamp.
4. Story execution **PAUSED** at Intake. No Develop agent is launched.
5. Developer responds via:
   - Dashboard: fills in missing spec items through the disambiguation UI form.
   - Telegram: `/disambiguate {story_id} {answers}` command.
6. Factory Core appends developer-provided answers to the story spec and re-runs the disambiguation agent on the updated spec.
7. **Round 2 pass:** score ≥ threshold → `disambiguation_passed = 1`, `disambiguation_resolved_at` = now, advance to Develop.
8. **Round 2 fail:** score still < threshold after developer response → developer is presented with a forced choice:
   - **Proceed anyway:** developer acknowledges incomplete spec. Factory Core records `disambiguation_passed = 0` with `forced_proceed = true`, advances to Develop, attaches warning to story record.
   - **Cancel story:** story status set to `cancelled_at_intake`, no Develop phase launched.
9. Maximum rounds before forced choice: **2** (original + 1 developer response round). This prevents indefinite blocking while still protecting against obviously incomplete specs.

---

### FR173: Calibration Record (Growth)

When a story satisfies BOTH conditions:
- `story_runs.disambiguation_passed = 1` (passed disambiguation without developer intervention)
- `story_runs.rework_cause = 'ambiguity'` (set by FR187 rework tracking)

Factory Core writes a calibration record:

```sql
CREATE TABLE IF NOT EXISTS disambiguation_false_negatives (
  id INTEGER PRIMARY KEY,
  story_id TEXT NOT NULL,
  disambiguation_score REAL NOT NULL,
  checklist_items_present TEXT NOT NULL,  -- JSON array of present item identifiers
  rework_cause_confirmed_at TEXT NOT NULL -- ISO8601
);
```

A daily observer process queries this table to compute:

```
false_negative_rate = COUNT(*) WHERE confirmed_at > (now - 30 days)
                      / COUNT(story_runs) WHERE disambiguation_passed = 1
                        AND created_at > (now - 30 days)
```

If false-negative rate exceeds a configurable threshold (default: `0.15`, i.e., 15% of passed stories later flagged as ambiguity rework), the observer emits a dashboard alert recommending recalibration of checklist weights or threshold. Automated threshold adjustment is a post-MVP concern; for MVP the alert is advisory only.

---

### Token Budget

| Component | Estimated Tokens | Notes |
|---|---|---|
| Story spec (average) | ~800 tokens | Varies; typical story spec is 400–1200 tokens |
| Codebase summary (scoped) | ~400 tokens | `.mulch/` summary scoped to declared files |
| System prompt + checklist | ~300 tokens | Static per work type |
| **Total prompt** | **~1,500 tokens** | |
| Agent response | ~500 tokens | JSON array of ~8 items with evidence strings |
| **Total per story** | **~2,000 tokens** | At economy tier ≈ $0.0008 per story (GLM-5 pricing) |

Cost is negligible relative to builder agent costs (~$0.05–$0.50 per story at standard tier).

---

### Failure Handling

If the disambiguation agent crashes, returns malformed JSON, or does not respond within **30 seconds**:

1. Factory Core logs a structured warning to events.db: `{ event_type: 'disambiguation_failure', story_id, error, duration_ms }`.
2. Sets `story_runs.disambiguation_score = NULL`, `disambiguation_passed = NULL`.
3. **Proceeds to Develop** immediately. Infrastructure failure NEVER blocks story execution.

Rationale: the disambiguation gate is a quality improvement, not a hard security gate. The cost of blocking a valid story on an agent crash is higher than the cost of occasionally advancing an under-specified story. Hard blocking is reserved for gates that detect active harm (CVE, SAST finding), not speculative incompleteness.

---

### Dashboard Integration

The Intake phase indicator gains a sub-indicator for the disambiguation gate state: `pending`, `passed`, `failed_querying_developer`, `failed_forced_proceed`, `skipped_infrastructure_error`. This is displayed as a secondary badge on the Intake phase card, not as a separate phase node in the pipeline graph.

---

## ADR-026: Production-Readiness Gate Extensions (Dependency Hygiene + SAST)

**Status:** Accepted
**Scope:** MVP (FR178, FR179)
**Affects:** Factory Core gate script registry (FR14a), hook runner, NFR3 budget allocation, gate result display in dashboard, PR evidence body (FR52)

---

### Context

The existing Layer 4 (phase boundary) gate checklist defined in FR14d runs 6 checks atomically at phase boundaries: tests passing, lint clean, type-check clean, scope violations absent, TDD pairs present, manifest schema valid. This checklist has no visibility into supply chain risk (newly introduced dependencies with CVEs) or static application security (OWASP-class vulnerabilities in modified code). Both categories of defect are expensive to remediate post-review. Adding them as gate checks at the DEVELOP→BMAD boundary catches them before BMAD agents see the code — preventing review agents from spending tokens on code that will be rejected on security grounds.

---

### Decision

Add two new gate scripts to Layer 4, extending the 6-check checklist to **8 checks**. Both scripts implement the ADR-010 stdin/stdout gate script interface:

- `scripts/gates/dependency-hygiene.ts` (FR178)
- `scripts/gates/sast-scan.ts` (FR179)

Both scripts run **only at the DEVELOP→BMAD phase boundary**. They are not registered at BMAD→QA or QA→Ship boundaries.

---

### Rationale: Gate Scripts (ADR-010 Pattern) vs. Inline Factory Core Logic

The ADR-010 gate script interface (GateContext on stdin, GateResult on stdout, exit codes 0/1/2) exists precisely to avoid embedding tool-specific logic in Factory Core. Inline logic would require:

1. Factory Core to import `npm audit` parsing logic, `semgrep` output parsing logic, and all future scanner parsers.
2. Scanner crashes to propagate as unhandled exceptions in the pipeline orchestrator process.
3. Each new scanner to modify `intake.ts` or `pipeline.ts` rather than adding a standalone executable.

The gate script pattern provides:

- **Crash isolation:** a gate script that crashes does not crash Factory Core. The hook runner catches non-zero exit and maps it to a GateResult.
- **Language-agnostic extension:** a future Python-based scanner or a Go binary can be registered without touching TypeScript.
- **Uniform result schema:** dashboard and PR evidence (FR52) handle all gate results identically regardless of which scanner produced them.

---

### Gate Script Placement

Both scripts are registered for the **DEVELOP→BMAD** phase boundary only.

Rationale: new dependencies are introduced during development; subsequent phases (BMAD→QA, QA→Ship) do not introduce new dependencies. SAST findings are properties of the code as written by builders; BMAD review agents should not encounter code with known OWASP violations — catching before BMAD ensures review agents evaluate corrected code. Running these checks at every boundary would add latency to BMAD→QA and QA→Ship for no risk-reduction benefit.

The gate script registry entry per gate script includes a `phase_boundary` field: `["develop_to_bmad"]`. This is read by the hook runner at phase boundary evaluation time.

---

### NFR3 Budget Analysis and Resolution

NFR3 requires total gate completion within **60 seconds**. The existing 6-check checklist worst-case breakdown:

| Check | Budget | Parallelism |
|---|---|---|
| Test suite | ≤45s | Sequential (dominates) |
| Build | ≤20s | Parallel with lint |
| Lint | ≤10s | Parallel with type-check |
| Type check | ≤15s | Parallel with lint |
| Uncommitted changes | ≤5s | Parallel with lint |
| Manifest validation | ≤5s | Parallel with lint |

Critical path: test suite (45s) → build (20s) is already over 60s if sequential, but the existing NFR3 compliant implementation runs build in parallel with the lint/type-check group, and tests dominate at 45s. The hook runner runs non-dependent checks concurrently.

New checks allocated sub-budgets:

| New Check | Sub-Budget | Parallelism Placement |
|---|---|---|
| Dependency hygiene | ≤10s | Parallel with lint/type-check group |
| SAST scan | ≤15s | Parallel with lint/type-check group |

Since both new checks join the parallel group that runs concurrently with the test suite, the marginal addition to the critical path is:

```
critical_path = max(test_suite, max(parallel_group_checks))
              = max(45s, max(20s build, 15s type-check, 15s SAST, 10s dep-hygiene, ...))
              = max(45s, 20s)
              = 45s
```

**No change to NFR3 critical path.** Both new checks complete within the test suite window. NFR3 ≤60s is preserved.

Timeout enforcement: the hook runner kills any gate script child process that exceeds its sub-budget. Killed processes → exit code mapped to `2` (degraded) with a timeout finding. This prevents a hung `npm audit` from blocking the pipeline.

---

### Gate Script: `scripts/gates/dependency-hygiene.ts` (FR178)

**ADR-010 interface compliance:**

- Input: `GateContext` written to stdin (JSON)
- Output: `GateResult` written to stdout (JSON)
- Exit codes: `0` = pass, `1` = fail (Critical/High CVE found), `2` = degraded (stale package or timeout)

**Logic:**

```
1. Read GateContext from stdin. Extract changed_files: string[].
2. Check if any lockfile appears in changed_files:
     lockfiles = ['package-lock.json', 'bun.lockb', 'yarn.lock', 'Cargo.lock']
     if none present in changed_files: write GateResult(passed: true, findings: []), exit 0.
3. Determine audit command:
     if 'bun.lockb' in changed_files: command = ['bun', 'audit', '--json']
     elif 'Cargo.lock' in changed_files: command = ['cargo', 'audit', '--json']
     else: command = ['npm', 'audit', '--json']
4. Spawn audit command via Bun.spawn(). Enforce 10s timeout (kill on expiry).
   On timeout: write GateResult(passed: false, degraded: true,
     findings: [{ severity: 'warning', category: 'dependency_stale',
                  message: 'Audit timed out after 10s' }]), exit 2.
5. Parse JSON output.
6. For each vulnerability:
     if severity in ['critical', 'high']: collect as fail finding, category: 'dependency_cve'
     if last_publish_date exists and age > 2 years: collect as warn finding, category: 'dependency_stale'
7. If any fail findings: exit 1.
   If any warn findings only: exit 2.
   Else: exit 0.
```

**GateResult findings for this script use categories:** `'dependency_cve'`, `'dependency_stale'`.

**Configuration check:** if `factory.yaml` has `quality.dependency_hygiene_enabled: false`, script writes GateResult(passed: true, findings: [{ severity: 'info', message: 'Dependency hygiene gate disabled via factory.yaml' }]), exit 0.

---

### Gate Script: `scripts/gates/sast-scan.ts` (FR179)

**ADR-010 interface compliance:**

- Input: `GateContext` written to stdin (JSON)
- Output: `GateResult` written to stdout (JSON)
- Exit codes: `0` = pass (or semgrep not installed advisory), `1` = fail (ERROR-severity OWASP finding), `2` = degraded (WARNING-severity finding)

**Logic:**

```
1. Read GateContext from stdin. Extract worktreePath: string, changed_files: string[].
2. Check factory.yaml: if quality.sast_enabled = false → exit 0 with advisory finding.
3. Derive modified file paths: filter changed_files to those that exist on disk
   (exclude deleted files). Resolve against worktreePath.
4. Check for semgrep binary on PATH:
     if not found:
       write GateResult(passed: true, findings: [{
         severity: 'warning',
         category: 'sast_owasp',
         message: 'semgrep not found — SAST gate skipped. Install semgrep for OWASP scanning.'
       }]), exit 0.
       // Advisory, not a block. Developer environments vary.
5. Read configuration:
     ruleset = factory.yaml quality.sast_ruleset ?? 'p/owasp-top-ten'
6. Spawn: semgrep scan --config={ruleset} --json --quiet {file1} {file2} ...
   Enforce 15s timeout (kill on expiry → exit 2 with timeout finding).
7. Parse semgrep JSON output (results array).
8. For each result:
     if result.extra.severity == 'ERROR': collect as fail finding, category: 'sast_owasp'
     if result.extra.severity == 'WARNING': collect as warn finding, category: 'sast_owasp'
9. If any fail findings: exit 1.
   If any warn findings only: exit 2.
   Else: exit 0.
```

**Why semgrep is not required:** developer environments vary widely. Enforcing a hard dependency on a Python-based scanner not part of the Bun/Node toolchain would create an installation barrier that is orthogonal to the factory's primary function. The advisory warning in the gate result is surfaced on the dashboard, providing visibility without blocking operation. Teams that want hard SAST enforcement can set `quality.sast_enabled: true` and ensure semgrep is installed in their CI environment, where the factory will then enforce it.

**Modified files scope:** only files from the story's git diff, not the full codebase. This keeps SAST scan time proportional to story size rather than codebase size, and ensures the 15s sub-budget is achievable for typical story scopes (5–20 modified files).

---

### GateResult Schema Extensions

Extend the `Finding.category` enum with:

```typescript
type FindingCategory =
  | 'test_failure'       // existing
  | 'lint_violation'     // existing
  | 'type_error'         // existing
  | 'scope_violation'    // existing
  | 'tdd_pair_missing'   // existing
  | 'manifest_invalid'   // existing
  | 'dependency_cve'     // new — FR178
  | 'dependency_stale'   // new — FR178
  | 'sast_owasp';        // new — FR179
```

These categories appear in the PR evidence body (FR52) in the **"Pre-BMAD Mechanical Validation"** section, alongside existing gate categories. The PR evidence renderer requires no special-casing — it renders all GateResult findings uniformly by category and severity.

---

### factory.yaml Configuration

```yaml
quality:
  # Layer 4 gate extensions
  dependency_hygiene_enabled: true          # FR178; set false to skip gate entirely
  sast_enabled: true                        # FR179; set false to skip gate entirely
  sast_tool: "semgrep"                      # Future: 'bandit', 'gosec', etc.
  sast_ruleset: "p/owasp-top-ten"          # Passed as --config to sast_tool
```

The `sast_tool` field is reserved for future extension. For MVP only `"semgrep"` is implemented. A `sast_tool: "none"` value produces the same result as `sast_enabled: false`.

---

### Dashboard Integration

The gate result display gains two new check rows in the phase boundary gate panel:

| Check | Icon (pass) | Icon (fail) | Icon (degraded) |
|---|---|---|---|
| Dependency Hygiene | pass | CVE found | Stale pkg / timeout |
| SAST (OWASP) | pass | Critical finding | Warning / not installed |

Both rows are only shown when the gate was evaluated (DEVELOP→BMAD boundary). They are absent from the BMAD→QA and QA→Ship boundary displays.

---

### Updated Layer 4 Gate Checklist (8 Checks)

| # | Check | Boundary | Timeout | Exit-on-fail |
|---|---|---|---|---|
| 1 | Tests passing | All | 45s | 1 |
| 2 | Lint clean | All | 10s | 1 |
| 3 | Type-check clean | All | 15s | 1 |
| 4 | Scope violations absent | All | 5s | 1 |
| 5 | TDD pairs present | All | 5s | 1 |
| 6 | Manifest schema valid | All | 5s | 1 |
| 7 | Dependency hygiene | Develop→BMAD only | 10s | 1 (CVE) / 2 (stale) |
| 8 | SAST (OWASP) | Develop→BMAD only | 15s | 1 (ERROR) / 2 (WARNING) |

Checks 7 and 8 run in the parallel group alongside checks 2–6, within the window dominated by check 1 (test suite). NFR3 60s ceiling is preserved.

---

# Architecture Decision Records: PR Confidence, Blast Radius, and Merge Governance

**Session:** 2026-03-15
**Author:** Winston (System Architect)
**Status of all three:** Accepted (Growth tier — prerequisites noted per ADR)

---

## ADR-027: PR-Level Confidence Score and Self-Assessment Accuracy

**Status:** Accepted (Growth — requires FR131 phase-boundary confidence data as prerequisite)

### Context

FR131 defines per-phase confidence calibration using Brier scores. FR181 extends this upward: at PR creation time, we need a single composite score that summarizes the factory's confidence in this specific PR. FR182 then closes the feedback loop by comparing predicted confidence to actual human review outcomes. Without FR182, FR131 scores are trained in a vacuum.

This ADR governs both the computation of the PR-level composite score and the self-assessment accuracy tracking layer that validates it over time.

### Decision

Aggregate per-phase confidence declarations into a PR-level composite score at PR creation time. Track predicted vs. actual outcomes. This is the meta-accuracy layer on top of outcome metrics.

### Affected Components

- Factory Core (`packages/factory-core/src/pr/confidence.ts`)
- `pipeline.db` schema (two new tables)
- PR evidence template (FR52)
- Dashboard Gateway
- Daily observer (FR77)

### Implementation Details

**PR confidence score computation**

At PR creation (after QA swarm completes), Factory Core queries `pipeline.db` for the story's phase data and computes:

```typescript
interface PRConfidenceFactors {
  phaseConfidenceAvg: float;        // mean of FR131 Brier-calibrated confidence across phases
  bmadSeverityScore: float;         // 1.0 - (critical_count * 0.3 + warning_count * 0.1) capped at 0
  qaCleanWaveRatio: float;          // clean_waves / total_waves from QA results
  blastRadiusFactor: float;         // 1.0 (low), 0.7 (medium), 0.4 (high) — 1.0 if FR192 not yet live
  rollbackRiskFactor: float;        // 1.0 (no rollback risk), 0.7 (medium risk), 0.4 (high risk)
}

// Composite: weighted average
// prConfidenceScore = 0.25*phaseConfidenceAvg + 0.25*bmadSeverityScore + 0.25*qaCleanWaveRatio
//                   + 0.15*blastRadiusFactor + 0.10*rollbackRiskFactor
```

**Rollback risk detection (FR184)**

At PR creation, Factory Core checks the git diff for:

1. Presence of migration files (paths matching `migrations/`, `db/migrate/`, `**/migrations/**`) → `has_schema_changes = true`
2. If `has_schema_changes`, check migration file content for `DROP TABLE`, `DROP COLUMN`, `RENAME COLUMN`, `ALTER COLUMN ... TYPE` → `schema_backward_compatible = false`
3. Lockfile diff → `introduces_new_dependencies = true/false`

Rollback risk classification:
- **HIGH:** `schema_backward_compatible = false`
- **MEDIUM:** `has_schema_changes = true` OR `introduces_new_dependencies = true`
- **LOW:** otherwise

**pipeline.db schema additions**

```sql
CREATE TABLE pr_confidence_records (
  id                    INTEGER PRIMARY KEY,
  story_id              TEXT NOT NULL,
  pr_url                TEXT NOT NULL,
  confidence_score      REAL NOT NULL,
  phase_confidence_avg  REAL NOT NULL,
  bmad_severity_score   REAL NOT NULL,
  qa_clean_wave_ratio   REAL NOT NULL,
  blast_radius_factor   REAL NOT NULL,
  rollback_risk_factor  REAL NOT NULL,
  rollback_risk_level   TEXT NOT NULL CHECK (rollback_risk_level IN ('low', 'medium', 'high')),
  has_schema_changes    INTEGER NOT NULL CHECK (has_schema_changes IN (0, 1)),
  computed_at           TEXT NOT NULL  -- ISO8601
);

CREATE TABLE pr_outcomes (
  id                INTEGER PRIMARY KEY,
  pr_id             INTEGER NOT NULL REFERENCES pr_confidence_records(id),
  actual_pass       INTEGER NOT NULL CHECK (actual_pass IN (0, 1)),
  comment_count     INTEGER NOT NULL DEFAULT 0,
  change_requested  INTEGER NOT NULL CHECK (change_requested IN (0, 1)),
  recorded_at       TEXT NOT NULL,  -- ISO8601
  recording_method  TEXT NOT NULL   -- "gh_poll_post_merge"
);
```

**Self-assessment accuracy computation**

After PR merge, Factory Core polls `gh pr reviews` and `gh pr comments` once (within 24h of merge detection):
- Zero non-bot comments and no change requests → `actual_pass = true`
- Any substantive comments → `actual_pass = false`, `comment_count` recorded

Self-assessment accuracy = `COUNT(actual_pass = predicted_pass) / COUNT(*)` where `predicted_pass = (confidence_score >= threshold)`. Threshold defaults to `0.75`, configurable in `factory.yaml`. Rolling over last 30 PRs. Displayed on dashboard.

**Dashboard display**

"Self-Assessment Accuracy" gauge on Factory Overview:
- Green: > 80%
- Yellow: 60–80%
- Red: < 60%

Tooltip shows: last 30 PRs, predicted vs. actual breakdown.

**PR evidence body inclusion (FR52)**

The PR evidence body includes a `## Factory Confidence` section:

```markdown
## Factory Confidence

| Signal | Score |
|--------|-------|
| Phase Confidence Avg | {phaseConfidenceAvg:.2f} |
| BMAD Severity Score  | {bmadSeverityScore:.2f} |
| QA Clean Wave Ratio  | {qaCleanWaveRatio:.2f} |
| Blast Radius Factor  | {blastRadiusFactor:.2f} |
| Rollback Risk Factor | {rollbackRiskFactor:.2f} |
| **Composite Score**  | **{prConfidenceScore:.2f}** |

Rollback Risk: {rollback_risk_level | upper}
```

### Consequences

**Positive:**
- Closes the feedback loop between factory confidence and real-world developer experience. This is the ONLY signal that validates FR131 in production conditions.
- Self-assessment accuracy dashboard provides a visible, actionable quality signal that degrades visibly if the factory is overconfident.
- Rollback risk detection (FR184) is a lightweight static check — no new tooling, just git diff parsing.

**Negative:**
- `gh pr reviews` polling introduces a 24h lag window. Outcomes for abandoned PRs (never merged) are not recorded — accuracy metric is therefore biased toward PRs the developer was satisfied enough to merge.
- Brier score calibration (FR131) and PR-level composite score use different aggregation windows. Cross-signal weighting (0.25 / 0.25 / 0.25 / 0.15 / 0.10) is an initial estimate. Weights should be tuned once 50+ PRs of outcome data exist.

### Prerequisites

- FR131 (phase-boundary Brier score confidence) must be live and populating `pipeline.db` before FR181 has meaningful data.
- FR192 (blast radius scorer) populates `blastRadiusFactor` — ADR-028 below. Until FR192 is live, `blastRadiusFactor` defaults to `1.0` (no penalty).

---

## ADR-028: Blast Radius Scorer Architecture

**Status:** Accepted (Growth — requires git history and test coverage data)

### Context

FR192 requires a pre-execution score that classifies the potential impact of a story's file scope before any code is written. This score gates BMAD wave counts, integration test mandates, and merge policy overrides. It must be computable at intake time (no code changes yet), using only static analysis of the existing codebase.

### Decision

Compute blast radius score as a multi-signal composite at story intake (after disambiguation), stored in `pipeline.db`, used by merge policy and BMAD phase configuration. Computed once per story — not recomputed during execution.

### Affected Components

- Factory Core (`packages/factory-core/src/pipeline/blast-radius.ts`)
- `pipeline.db` schema (`story_runs` table extension)
- Story intake flow
- BMAD phase configuration (additional waves)
- Merge policy (FR193, ADR-029)

### Implementation Details

**When computed**

During the Intake phase, after the disambiguation gate (ADR-025), before Develop begins. A failed or missing blast radius computation never blocks story execution — it defaults to MEDIUM for all missing signals.

**Signal 1: Downstream importer count**

Factory Core runs static import analysis on the declared file scope. For TypeScript/JavaScript: parse `import` and `require` statements across the entire codebase. Count files that import any file in the story's declared scope.

Import graph cached in `pipeline.db`:

```sql
CREATE TABLE import_graph (
  importer_path   TEXT NOT NULL,
  importee_path   TEXT NOT NULL,
  last_analyzed_at TEXT NOT NULL,  -- ISO8601
  PRIMARY KEY (importer_path, importee_path)
);
```

Cache TTL: 4 hours (configurable via `factory.yaml`). Invalidated on any file change in scope. Cost: approximately 2–5 seconds for initial analysis on a 10K-file project; subsequent runs use the cache.

**Signal 2: Test coverage density**

Read from `.qds/coverage/latest.json` (Factory Core writes this after each full test run). Coverage density = `covered_lines / total_lines` for each declared file. Missing coverage data (file never covered or never analyzed) = `0.0` density.

**Signal 3: Git churn × defect rate**

```bash
# Churn: commit count for file
git log --follow --oneline -- {file}

# Defect rate: fix/bug commits ÷ total commits
git log --oneline --grep='fix\|bug\|defect\|patch' -- {file} | wc -l
```

`churn_score = commit_count * defect_rate`. Capped at `10.0` for normalization.

**Signal 4: Code age**

```bash
git log --follow -1 --format="%ci" -- {file}
```

Age in days since last modification. Recently changed files = higher risk (active churn zone). Older stable files = lower risk.

**Composite classification**

```typescript
function classifyBlastRadius(signals: BlastRadiusSignals): "low" | "medium" | "high" {
  const importerScore = signals.maxDownstreamImporters > 20 ? 3
    : signals.maxDownstreamImporters > 5 ? 2 : 1;
  const coverageScore = signals.minCoverageDensity < 0.3 ? 3
    : signals.minCoverageDensity < 0.7 ? 2 : 1;
  const churnScore = signals.maxChurnScore > 5 ? 3
    : signals.maxChurnScore > 2 ? 2 : 1;
  const ageScore = signals.minAgeDays < 7 ? 3
    : signals.minAgeDays < 30 ? 2 : 1;  // recently changed = higher risk

  const composite = (importerScore + coverageScore + churnScore + ageScore) / 4;
  return composite >= 2.5 ? "high" : composite >= 1.75 ? "medium" : "low";
}
```

**pipeline.db schema**

Extend `story_runs`:

```sql
ALTER TABLE story_runs ADD COLUMN blast_radius TEXT
  CHECK (blast_radius IN ('low', 'medium', 'high')) DEFAULT NULL;
ALTER TABLE story_runs ADD COLUMN blast_radius_signals TEXT DEFAULT NULL;  -- JSON
```

**Behavioral consequences**

| Classification | BMAD Waves | Integration Test Mandate | Merge Policy Override |
|---|---|---|---|
| HIGH | 4 agents (instead of 3) | Yes (FR175) | `supervised` regardless of domain mode |
| MEDIUM | 3 agents (default) | No | Dashboard warning badge |
| LOW | 3 agents (default) | No | No override |

**Failure handling**

If any signal computation fails (git command fails, coverage file missing, import analysis errors), that signal defaults to its MEDIUM score value. Score computation continues with the remaining signals. Blast radius computation never blocks story execution.

### Consequences

**Positive:**
- Pre-execution risk classification means high-risk stories get more review resources automatically, without developer intervention.
- Import graph cache amortizes the cost across the session — only the first story per session incurs the full analysis cost.
- Failure-safe default (MEDIUM) means the system degrades gracefully if git history is shallow or coverage data is stale.

**Negative:**
- Import graph analysis is static — it cannot detect runtime dynamic imports (`require(variable)`) or dependency injection patterns. These will be undercounted.
- `minAgeDays < 7` penalizes recently-touched files, which may include files touched only by the factory itself in earlier stories. This creates a compounding risk signal that may need tuning.
- Coverage data requires a prior full test run. Newly scaffolded projects with no test run will have all files at `0.0` coverage density, biasing toward MEDIUM/HIGH for all stories until tests are run once.

### Prerequisites

- Git history must be accessible (shallow clones with `--depth=1` will produce degraded signal quality for churn and age).
- `.qds/coverage/latest.json` format is owned by Factory Core's test runner integration. Must be stable before FR192 is activated.

---

## ADR-029: Confidence-Gated Merge Policy and Domain Trust Governance

**Status:** Accepted (Growth — requires FR133 ELO ratings as prerequisite for Autonomous mode)

### Context

FR193 and FR194 define a three-mode merge governance model where the factory progressively earns the right to merge without human review, domain by domain, as ELO evidence accumulates. The default is always Supervised (human required). Autonomous mode is the destination, not the starting point.

This ADR governs mode determination, domain trust taxonomy, auto-merge implementation, and the safety constraints that cannot be overridden by configuration.

### Decision

Three-mode merge governance model, per-project configurable, per-domain ELO gated. Autonomous mode is the DESTINATION, not the default.

### Affected Components

- Factory Core (`packages/factory-core/src/pr/merge-policy.ts`)
- `factory.yaml` schema
- `pipeline.db` schema (`story_runs` table extension)
- PR creation flow (FR52)
- Domain trust taxonomy in `factory.yaml`

### Implementation Details

**Mode determination algorithm**

```typescript
function determineMergeMode(story: StoryRecord, domain: string): MergeMode {
  const configuredMode = config.merge_policy.mode; // "autonomous" | "assisted" | "supervised"
  const domainElo = db.getElo(domain);             // null if FR133 not yet live
  const domainRisk = config.domain_risk[domain] ?? "medium_risk";
  const minEloForMode = config.domain_risk_elo_thresholds[domainRisk][configuredMode];
  const successfulPrsInDomain = db.countSuccessfulPrs(domain);
  const minPrsRequired = config.merge_policy.min_prs_for_autonomous ?? 10;

  // Hard overrides — always take precedence, cannot be configured away
  if (story.blast_radius === "high") return "supervised";
  if (story.rollback_risk_level === "high") return "supervised";

  // Domain gating: not enough evidence → supervised regardless of configured mode
  if (configuredMode === "autonomous" && successfulPrsInDomain < minPrsRequired) return "supervised";
  if (domainElo !== null && domainElo < minEloForMode) return "supervised";

  return configuredMode as MergeMode;
}
```

**Domain trust taxonomy (`factory.yaml`)**

```yaml
domain_risk:
  "src/utils/**": "low_risk"
  "src/formatters/**": "low_risk"
  "src/features/**": "medium_risk"
  "src/services/**": "high_risk"
  "src/auth/**": "critical"
  "src/payments/**": "critical"
  "migrations/**": "critical"

domain_risk_elo_thresholds:
  low_risk:
    autonomous: 1200
    assisted: 1100
  medium_risk:
    autonomous: 1400
    assisted: 1200
  high_risk:
    autonomous: 1600
    assisted: 1400
  critical:
    autonomous: 1800      # effectively disables Autonomous for critical domains
    assisted: 1600

merge_policy:
  mode: "supervised"          # default for all new projects — must be explicit to change
  min_prs_for_autonomous: 10
  assisted_delay_hours: 2     # wait period before auto-merge in Assisted mode
```

**pipeline.db schema**

Extend `story_runs`:

```sql
ALTER TABLE story_runs ADD COLUMN merge_mode_determined TEXT
  CHECK (merge_mode_determined IN ('autonomous', 'assisted', 'supervised')) DEFAULT NULL;
ALTER TABLE story_runs ADD COLUMN merge_mode_override_reason TEXT DEFAULT NULL;
ALTER TABLE story_runs ADD COLUMN pr_auto_merged_at TEXT DEFAULT NULL;  -- ISO8601, null if supervised
```

**Assisted mode implementation**

At PR creation, if `merge_mode_determined = "assisted"`:

1. Create PR normally via `gh pr create` (FR52).
2. Send Telegram notification: "Auto-merging in {delay}h unless you object — reply `/block {story_id}` to prevent."
3. Schedule a delayed merge check via the daily cron (no background daemon required).
4. At T+delay: if no `/block` received AND CI is passing → `gh pr merge {pr_number} --merge`. Record `pr_auto_merged_at`.
5. If `/block` received: downgrade to Supervised, notify developer that merge is paused awaiting review.

**Autonomous mode implementation**

At PR creation, if `merge_mode_determined = "autonomous"`:

1. Create PR normally via `gh pr create`.
2. Poll CI via `gh pr checks` (FR54) with 30s interval, max 30 polls (15 minutes total).
3. If all checks pass → `gh pr merge {pr_number} --merge`. Record `pr_auto_merged_at`.
4. If CI fails or timeout reached → downgrade to Supervised for this PR, notify developer.

**Hard safety constraints (non-configurable)**

The following conditions always force `supervised` mode, regardless of `factory.yaml` configuration, domain ELO, or PR count:

- `story.blast_radius === "high"` (ADR-028)
- `story.rollback_risk_level === "high"` (ADR-027 / FR184)
- `domainElo === null` AND `configuredMode === "autonomous"` (FR133 not yet live)
- `successfulPrsInDomain < min_prs_for_autonomous` (insufficient domain evidence)

These constraints exist at the code level in `merge-policy.ts` and are not overridable by configuration. They must be covered by unit tests that verify the hard-override behavior independently of `factory.yaml` content.

**Why no partial autonomous (auto-merge some files but not others)**

Atomic PR merges are simpler and avoid creating a "split reality" in the codebase where some changes are live and others are pending. The blast radius scorer (ADR-028) ensures high-risk file changes always use Supervised mode — the correct response to a mixed-risk PR is to classify it at the highest-risk file's level, not to split the PR.

**Security consideration**

`gh pr merge` uses the same GitHub token as all other factory operations (fine-grained PAT per NFR-SEC-09). Auto-merge is explicitly in scope of the factory's authorized actions — it is not a new permission boundary.

However: Autonomous mode MUST NOT be activated without explicit `mode: "autonomous"` in `factory.yaml`. The default `"supervised"` ensures no accidental auto-merges on new project setups. This is enforced at startup: Factory Core validates `factory.yaml` on init and logs a prominent warning if `mode` is not explicitly set (rejecting an implicit default that happens to equal `"autonomous"`).

### Consequences

**Positive:**
- Supervised default means no project accidentally enters auto-merge. Trust must be explicitly configured and then earned via ELO evidence.
- Domain-level granularity allows `src/utils/**` to reach Autonomous while `src/payments/**` stays permanently Supervised — matching real-world risk intuition.
- Assisted mode provides a middle ground for teams that want automation with a veto window, without requiring full ELO evidence accumulation.

**Negative:**
- Domain matching uses glob patterns in `factory.yaml`. A story touching files that match multiple patterns (e.g., `src/utils/auth-helpers.ts` matching both `src/utils/**` and `src/auth/**`) uses the highest-risk classification. This is intentional but may surprise developers.
- Assisted mode relies on the daily cron for delayed merge scheduling — not a real-time scheduler. Actual delay may be `delay_hours` to `delay_hours + 24h` depending on cron timing. This is documented in the Telegram notification.
- FR133 ELO ratings are a prerequisite for Autonomous mode. Until FR133 is live, all domains have `domainElo = null`, and the hard constraint forces Supervised regardless of `factory.yaml`. This is the correct behavior — Autonomous without evidence is unsafe.

### Prerequisites

- FR133 (ELO-style domain ratings) must be live and populating `pipeline.db` before any domain can qualify for Autonomous mode.
- ADR-028 (blast radius scorer) must be live before `blast_radius` hard overrides are meaningful.
- ADR-027 (rollback risk detection) must be live before `rollback_risk_level` hard overrides are meaningful.
- Fine-grained GitHub PAT must include `pull_requests: write` scope (required for `gh pr merge`). Verify during factory init and fail fast if scope is missing.

---

# Architecture Session 12 Amendments

**Date:** 2026-03-15
**Author:** Winston (System Architect)
**Status:** Draft — awaiting PM sign-off

---

## ADR-030: Learning Loop Extensions (Rework Cause Taxonomy + PR Defect Classification)

**Status:** Accepted (Growth)

### Decision

Extend the learning record schema with a `rework_cause` field populated at fix-loop entry by Factory Core's orchestrator, and extend the FR90 PR-to-Seeds pipeline with an economy-tier defect classification agent that tags each Seeds issue with a category from the 7-item PR defect taxonomy.

### Context

ADR-015 established the learning system: raw records written by agents to `.qds/learnings/`, synthesized by FR59 into `.qds/learnings/synthesized/`. FR187 and FR190 are growth-tier extensions to close the feedback loop between factory failures and structured, queryable cause data.

Without structured cause data, the daily observer (FR77) can only report that rework occurred; it cannot distinguish ambiguity-driven failures from skill gaps or pattern misses. Without PR defect classification, Seeds issues accumulate without trend visibility — the factory cannot detect a category of defects that is stubbornly not improving.

Both extensions share a common dependency: economy-tier agent invocations that happen asynchronously after a causal event, never in the hot path.

### Affects

- Factory Core: learning record writer, fix-loop entry handler, FR90 PR webhook handler
- `pipeline.db` schema: two additions (`story_runs.rework_cause`, `pr_defect_classifications` table)
- Daily observer (FR77): rework rate dimension breakdown gains `ambiguity_caused_rate`
- `.qds/learnings/` YAML schema: one new optional field

### Implementation Details

#### Learning Record Schema Extension

Add one optional field to the learning record YAML written by Factory Core when a story enters fix loop (FR7) or completes with a non-success outcome:

```yaml
# .qds/learnings/<story-id>-<timestamp>.yaml
story_id: "story-1.3"
outcome: "failed_qa"
file_scope: ["src/pipeline/", "src/attribution/"]
content_hash: "<sha256>"
rework_cause: "ambiguity"   # NEW optional field — FR187
                             # enum: ambiguity | skill_gap | pattern_miss |
                             #        scope_creep | external_change
findings: []
```

The field is set by Factory Core's orchestrator — not by the agent — using the following two-pass logic:

**Pass 1 — Ambiguity signal (deterministic):** At story intake, Factory Core records a `disambiguation_score` in `story_runs`. If the score falls below the configured threshold (default: 0.6) AND the story subsequently enters fix loop, the orchestrator sets `rework_cause = "ambiguity"` without spawning an additional agent.

**Pass 2 — All other causes (economy-tier agent):** When Pass 1 does not trigger, Factory Core spawns an economy-tier classification agent with the following prompt context:
- The BMAD finding that triggered the fix loop (plain text, max 500 tokens)
- The 5-value taxonomy with definitions
- JSON output schema: `{ "rework_cause": string, "confidence": float, "rationale": string }`

The agent output is validated against the enum before being written. If confidence < 0.5 or the field fails validation, `rework_cause` is left null — the record is valid without it.

```typescript
// Pseudocode — Factory Core fix-loop entry handler
async function onFixLoopEntry(storyRun: StoryRun, trigger: BmadFinding): Promise<void> {
  let reworkCause: ReworkCause | null = null;

  if (storyRun.disambiguationScore < DISAMBIGUATION_THRESHOLD) {
    reworkCause = "ambiguity";
  } else {
    const result = await spawnEconomyAgent("rework-classifier", {
      finding: trigger.text,
      taxonomy: REWORK_CAUSE_TAXONOMY,
    });
    if (result.confidence >= 0.5 && isValidReworkCause(result.rework_cause)) {
      reworkCause = result.rework_cause;
    }
  }

  await writeLearningRecord({ ...storyRun, reworkCause });
  await db.run(
    "UPDATE story_runs SET rework_cause = ? WHERE id = ?",
    [reworkCause, storyRun.id]
  );
}
```

#### PR Defect Taxonomy Classification

When FR90 creates a Seeds issue from a human PR comment, Factory Core immediately queues an economy-tier classification job. The job is fire-and-forget relative to the Seeds issue creation — Seeds issue is written first, classification follows asynchronously.

**Seven-category taxonomy:**

| Category | Definition |
|---|---|
| `spec_interpretation_error` | Agent misread or over-interpreted the story spec |
| `codebase_pattern_miss` | Agent deviated from established patterns in the codebase |
| `test_gap` | Insufficient test coverage for the changed code |
| `scope_violation` | Change touched files or concerns outside story scope |
| `architecture_violation` | Change violates a recorded ADR or architectural constraint |
| `observability_gap` | Missing logs, metrics, or tracing for a critical path |
| `security_issue` | Security weakness introduced by the change |

Economy-tier agent input: PR comment text (max 300 tokens) + story context summary (max 200 tokens). Output schema: `{ "category": string, "confidence": float, "rationale": string }`.

The agent is context-isolated from the development agents that produced the PR. It receives no code — only the human reviewer's comment and the story title/description.

#### pipeline.db Schema Additions

```sql
-- Extend story_runs with rework cause
ALTER TABLE story_runs ADD COLUMN rework_cause TEXT
  CHECK (rework_cause IN (
    'ambiguity', 'skill_gap', 'pattern_miss', 'scope_creep', 'external_change'
  ));

-- New table for PR defect classifications
CREATE TABLE pr_defect_classifications (
  id              INTEGER PRIMARY KEY,
  pr_id           TEXT NOT NULL,
  seeds_issue_id  TEXT NOT NULL,
  category        TEXT NOT NULL CHECK (category IN (
    'spec_interpretation_error', 'codebase_pattern_miss', 'test_gap',
    'scope_violation', 'architecture_violation', 'observability_gap', 'security_issue'
  )),
  confidence      REAL NOT NULL,
  rationale       TEXT NOT NULL,
  classified_at   TEXT NOT NULL   -- ISO8601
);
CREATE INDEX idx_pdc_category ON pr_defect_classifications(category);
CREATE INDEX idx_pdc_classified_at ON pr_defect_classifications(classified_at);
```

#### Daily Observer Dimension Extension

The existing rework rate dimension gains `ambiguity_caused_rate`. This field is nullable until FR187 is live and at least one learning record with `rework_cause = "ambiguity"` has been written:

```yaml
rework_rate:
  bmad_caused_rate: 0.12
  qa_caused_rate: 0.08
  hook_caused_rate: 0.03
  ambiguity_caused_rate: null   # null until FR187 live
  total: 0.23
  anomaly: false
```

Defect category trend computation: daily observer runs a weekly aggregation over `pr_defect_classifications`, computes week-over-week delta per category, and sets `anomaly: true` on any category whose count is not decreasing over two consecutive weeks. This surfaces persistent defect patterns without requiring a human to manually inspect Seeds backlogs.

### Trade-off Rationale

**Economy tier for classification:** Full classification quality is not required for trend visibility. Economy tier reduces cost-per-classification to near-zero, making it viable to classify every PR comment and every fix-loop entry. Confidence thresholding (0.5 floor) mitigates accuracy risk — low-confidence classifications are discarded rather than written as misleading signal.

**Orchestrator sets rework_cause, not agent:** Agents classifying their own failures introduces motivated reasoning. The orchestrator has access to deterministic signals (disambiguation score, which phase triggered the fix loop) that the agent does not. Economy-tier classification is reserved for cases where deterministic signals are insufficient.

**Asynchronous classification:** Seeds issue creation must not be blocked on classification latency. The Seeds issue is useful immediately; the category enrichment is useful only in aggregate over time. Decoupling the writes keeps FR90 latency unchanged.

---

## ADR-031: Mulch Domain and Style Profile Extensions

**Status:** Accepted (Growth)

### Decision

Extend the `.mulch/` shared knowledge store with two new subdirectories: `.mulch/domain/` for entity invariants, idempotency annotations, fragile integration notes, and business rule assertions; and `.mulch/style/` for error handling strategy, naming conventions, abstraction level expectations, and concern separation rules. Both directories are injected into builder and BMAD overlays via the existing FR35 file-path scoping mechanism.

### Context

FR64-FR68 established `.mulch/` as a git-tracked, append-only shared knowledge store with two directories: `.mulch/conventions/` and (implied) a general knowledge area. The overlay assembly pipeline (FR28a Stage 3) injects Mulch content scoped to the story's declared file paths.

BMAD reviewers currently catch architectural violations by reasoning from the system prompt and whatever code context they can see. This is brittle: reviewers cannot reliably detect domain invariant violations (e.g., a payment operation that is not idempotent) or style drift (e.g., a service layer that has started importing HTTP framework types) unless those constraints are made explicit.

Domain and style knowledge lives today in: ADRs (too abstract), individual developer memories (not shared), and BMAD finding history (not proactively injected). ADR-031 makes this knowledge structured, scoped, and automatically available to every agent that touches a relevant file path.

### Affects

- `.mulch/` directory structure: two new subdirectories
- Overlay assembly pipeline: FR28a Stage 3 reads new subdirectories
- BMAD reviewer system prompt: new semantic coherence dimension
- `qds` CLI: two new subcommands for human curation
- Token budget: Stage 3 estimated addition of 500-800 tokens for a typical story scope

### Implementation Details

#### `.mulch/domain/` Directory Structure

One YAML file per business domain or module. File naming convention: `<module-slug>.yaml` (e.g., `payments.yaml`, `webhooks.yaml`, `auth.yaml`). The `module` field is the canonical path prefix used for FR35 scope matching.

```yaml
# .mulch/domain/payments.yaml
module: "src/payments"
last_modified: "2026-03-10T14:22:00Z"
provenance: "extracted from BMAD findings on story-2.4 and story-3.1"

entities:
  - name: "Order"
    invariants:
      - "total_amount must equal sum of line_item.amount for all line_items"
      - "status transitions: pending → confirmed → shipped → delivered"
      - "cancelled orders are terminal — no further transitions permitted"

operations:
  - name: "processPayment"
    idempotent: true
    idempotency_key: "transaction_id"
    notes: "Stripe charge creation must be guarded by idempotency key on every call path"

fragile_integrations:
  - system: "Stripe"
    notes: "webhook signature validation must happen before request body is parsed; body parsing consumes the raw buffer"
  - system: "TaxJar"
    notes: "rate lookups are cached 24h; do not call on every line item"

business_rules:
  - "refunds only allowed within 30 days of order creation"
  - "partial refunds require manager-level authorization token in session"
```

#### `.mulch/style/` Directory Structure

One YAML file per architectural layer or directory scope. The `scope` field uses glob syntax, matched against the story's declared file paths using the same glob engine as FR35.

```yaml
# .mulch/style/service-layer.yaml
scope: "src/**"
last_modified: "2026-02-28T09:00:00Z"
provenance: "codified from ADR-011 and team convention review 2026-02"

error_handling: >
  Service layer catches domain errors (DomainError subclasses) and re-wraps
  as ServiceError with an error code. Controller layer catches ServiceError
  and maps to HTTP status. Raw exceptions must never reach the controller.

naming_conventions:
  - "repositories: *Repository suffix (e.g., OrderRepository)"
  - "services: *Service suffix (e.g., PaymentService)"
  - "DTOs: *Dto suffix, kept in src/dto/"
  - "domain entities: no suffix (e.g., Order, Payment, Refund)"

abstraction_levels:
  - path: "src/domain/"
    rule: "pure business logic only; no framework imports, no HTTP types, no database drivers"
  - path: "src/infrastructure/"
    rule: "all external I/O adapters live here; no business logic"
  - path: "src/application/"
    rule: "orchestration only; calls domain and infrastructure, never does I/O directly"

concern_separation:
  - "controllers: input validation and HTTP mapping only; delegate all logic to services"
  - "services: business orchestration only; no SQL, no HTTP client calls"
  - "repositories: data access only; no business logic, no HTTP"
```

#### Overlay Injection

The FR28a Stage 3 (Mulch) overlay assembly step already reads `.mulch/` recursively. No new injection mechanism is required — the change is additive:

1. Stage 3 collects all `.yaml` files under `.mulch/domain/` and `.mulch/style/`.
2. Domain entries: matched if the story's declared file scope has a path prefix that begins with the entry's `module` field.
3. Style entries: matched if the story's declared file scope contains at least one path that matches the entry's `scope` glob.
4. Matched entries are serialized to the overlay token budget. If total Stage 3 budget (3,000 tokens, FR28a) would be exceeded, truncate by ascending `last_modified` — oldest entries dropped first.

```typescript
// Pseudocode — Stage 3 Mulch overlay assembly extension
function collectMulchEntries(storyFileScope: string[]): MulchEntry[] {
  const domainEntries = loadYamlDir(".mulch/domain/").filter(entry =>
    storyFileScope.some(path => path.startsWith(entry.module))
  );
  const styleEntries = loadYamlDir(".mulch/style/").filter(entry =>
    storyFileScope.some(path => minimatch(path, entry.scope))
  );
  const all = [...domainEntries, ...styleEntries]
    .sort((a, b) => b.last_modified.localeCompare(a.last_modified));
  return truncateToTokenBudget(all, STAGE3_TOKEN_BUDGET_REMAINING);
}
```

#### BMAD Reviewer System Prompt Extension

The BMAD reviewer system prompt gains one new paragraph appended to the semantic coherence section:

> "Your context includes domain invariants and style profile entries from the project's Mulch knowledge store. For every file in the story's declared scope, check that new code respects all domain invariants (entity state transitions, idempotency requirements, business rules) and style conventions (error handling strategy, naming, abstraction level, concern separation). Flag violations as Warning findings with category `domain_violation` or `style_violation`. Include the specific invariant or convention that was violated in the finding text."

This is purely additive — existing BMAD finding categories are unchanged.

#### Human Curation Workflow

Two new `qds` CLI subcommands scaffold YAML templates:

```bash
qds mulch add-domain <module-path> [--entity <EntityName>]
# Creates .mulch/domain/<slug>.yaml with empty template pre-filled with module path

qds mulch add-style <scope-glob>
# Creates .mulch/style/<slug>.yaml with empty template pre-filled with scope
```

Growth addition: the daily observer reads the last 30 days of BMAD findings and, when three or more findings share a common subject (e.g., "payment idempotency"), emits a suggestion in the daily journal:

```yaml
mulch_suggestions:
  - type: "domain_invariant"
    module: "src/payments"
    rationale: "3 BMAD findings in 30d reference payment idempotency; consider adding to .mulch/domain/payments.yaml"
```

Human acts on the suggestion; no auto-write to `.mulch/`. Append-only constraint preserved.

### Trade-off Rationale

**One file per module, not one monolithic file:** Scoped files make FR35 matching precise and keep token injection proportional to the story's actual scope. A story touching only `src/payments/` does not receive style entries for `src/auth/`.

**YAML over free-form markdown:** Structured YAML enables programmatic matching (glob, prefix), token-budget truncation by field, and future auto-detection. Free-form markdown would require an LLM to extract scoping signals at injection time, adding latency and cost.

**Human curation, not auto-write:** Domain invariants and style conventions are high-stakes. Incorrect auto-written entries would silently corrupt BMAD judgments. Suggestions lower the curation burden without removing human judgment from the write path.

**No new injection mechanism:** Reusing FR35 file-path scoping avoids adding a new overlay stage or a new configuration surface. The cost is that scope matching is path-prefix-based, which may be coarser than ideal for projects with non-hierarchical module organization. This is acceptable for the Growth tier.

---

## ADR-032: Observer Dimension Extensions and Operational Metrics

**Status:** Accepted (MVP: FR191, FR180, FR183; Growth: FR185, FR186)

### Decision

Extend the FR77 daily observer with five new journal dimensions (cycle time, rework rate, PR size distribution, defect escape rate, parallelization yield) and extend `pipeline.db`'s `story_runs` table with the columns needed to compute them. No new infrastructure is required — all metrics are derived from data Factory Core already records or can record with minor additions to existing write paths.

The FR77 daily journal schema is a Sprint 0 prerequisite artifact. It must be updated to include all five new dimensions before any observer or dashboard implementation begins, even for Growth-tier dimensions, so that the schema is stable when dashboard consumers are built.

### Context

FR77 defines the daily observer as a 9-dimension cron agent that writes structured YAML journals to `.qds/meta/daily/YYYY-MM-DD.yaml`. The journal schema is consumed by the Dashboard Gateway and by the weekly/monthly roll-up agents.

FR180, FR183, FR191 are MVP-tier metrics: cycle time, PR size awareness, and rework rate. FR185 and FR186 are Growth-tier: defect escape rate and parallelization yield. All five share the same architectural pattern — Factory Core writes raw data to `pipeline.db` on existing event boundaries, and the daily observer reads and aggregates at cron time.

Separating data collection (Factory Core, event-driven) from aggregation (daily observer, cron-driven) keeps the hot path free of aggregation overhead and gives the daily observer a clean, queryable source of truth.

### Affects

- `pipeline.db` schema: `story_runs` new columns, new `story_wait_times` table
- Factory Core: PR creation handler (git diff call), story intake handler (complexity band), fix-loop handler (wait time recording)
- Daily observer (FR77): five new computation blocks
- FR77 daily journal schema (Sprint 0 prerequisite artifact): schema extension required before implementation
- Dashboard: Factory Overview "Metrics" card (no new SSE channels)

### Implementation Details

#### pipeline.db Schema Additions

```sql
-- Extend story_runs with metric columns
ALTER TABLE story_runs ADD COLUMN intake_at          TEXT;           -- ISO8601
ALTER TABLE story_runs ADD COLUMN pr_created_at      TEXT;           -- ISO8601
ALTER TABLE story_runs ADD COLUMN pr_merged_at        TEXT;           -- ISO8601, nullable
ALTER TABLE story_runs ADD COLUMN cycle_time_seconds  INTEGER;        -- computed at PR creation
ALTER TABLE story_runs ADD COLUMN lines_changed       INTEGER;        -- from git diff --stat
ALTER TABLE story_runs ADD COLUMN complexity_band     TEXT CHECK (
  complexity_band IN ('small', 'medium', 'large')
);
ALTER TABLE story_runs ADD COLUMN caused_production_issue INTEGER
  NOT NULL DEFAULT 0 CHECK (caused_production_issue IN (0, 1));

-- New table for pipeline wait time tracking (FR186)
CREATE TABLE story_wait_times (
  id            INTEGER PRIMARY KEY,
  story_id      TEXT NOT NULL,
  wait_reason   TEXT NOT NULL CHECK (wait_reason IN ('dependency', 'contention', 'capacity')),
  wait_start_at TEXT NOT NULL,   -- ISO8601
  wait_end_at   TEXT            -- ISO8601, null if wait ongoing
);
CREATE INDEX idx_swt_story_id ON story_wait_times(story_id);
CREATE INDEX idx_swt_wait_start ON story_wait_times(wait_start_at);
```

#### Cycle Time Computation (FR180)

`intake_at` is written when a story is accepted into the pipeline. `pr_created_at` is written when Factory Core opens the PR via the Git provider API. `cycle_time_seconds` is computed and stored at PR creation time — it is not recomputed by the observer.

Complexity band is set at intake based on the story's declared file count:

| Band | Declared file count |
|------|-------------------|
| `small` | 1-5 files |
| `medium` | 6-20 files |
| `large` | > 20 files |

```typescript
// Pseudocode — PR creation handler
async function onPrCreated(storyRun: StoryRun, prUrl: string): Promise<void> {
  const prCreatedAt = new Date().toISOString();
  const cycleTimeSeconds = storyRun.intakeAt
    ? Math.floor((Date.now() - new Date(storyRun.intakeAt).getTime()) / 1000)
    : null;

  const gitDiffOutput = await Bun.spawn(["git", "diff", "--stat", "HEAD~1"]).text();
  const linesChanged = parseGitDiffStatTotal(gitDiffOutput);

  await db.run(`
    UPDATE story_runs
    SET pr_created_at = ?, cycle_time_seconds = ?, lines_changed = ?
    WHERE id = ?
  `, [prCreatedAt, cycleTimeSeconds, linesChanged, storyRun.id]);
}
```

Daily observer computes rolling average cycle time per band for the trailing 30 days. Anomaly detection: flag if any band's average exceeds its 30-day rolling mean by more than 1.5 standard deviations.

#### PR Size Tracking (FR183)

`git diff --stat HEAD~1` is called at PR creation. The output's final summary line (`N files changed, M insertions(+), K deletions(-)`) is parsed to extract total lines changed (`M + K`). This is a pure local git operation — no external API calls.

Configurable warning threshold defaults to 300 lines. Factory Core emits a `pr_size_warning` event if `lines_changed > threshold`. The event is recorded in `events.db` (Overstory-owned) and surfaced in the daily journal's `pr_size_distribution.anomaly` flag.

#### Defect Escape Rate (FR185, Growth)

`caused_production_issue` is set to `1` by a human operator via a `qds pr mark-production-issue <pr-id>` CLI command or via a future webhook from an incident tracking system. The factory does not auto-detect production issues.

Daily observer query:

```sql
SELECT
  CAST(SUM(caused_production_issue) AS REAL) /
  NULLIF(COUNT(*), 0) AS defect_escape_rate
FROM story_runs
WHERE pr_merged_at IS NOT NULL
  AND pr_merged_at >= datetime('now', '-90 days');
```

Rolling 90-day window. Anomaly: flag if rate exceeds 0.05 (5%) or increases week-over-week for two consecutive weeks.

#### Parallelization Yield (FR186, Growth)

Factory Core records a row in `story_wait_times` whenever a story enters a wait state (dependency not met, pipeline contention, or capacity limit reached). `wait_end_at` is set when the story exits the wait state.

Daily observer computes:

```sql
-- Total wait minutes for the day
SELECT SUM(
  (JULIANDAY(COALESCE(wait_end_at, datetime('now'))) -
   JULIANDAY(wait_start_at)) * 1440
) AS total_wait_minutes
FROM story_wait_times
WHERE wait_start_at >= datetime('now', 'start of day');
```

Utilization percentage: `(stories_active_time) / (stories_active_time + total_wait_minutes)`. Active time is approximated as `SUM(cycle_time_seconds) / 60` for stories active during the day.

#### FR77 Daily Journal Schema Extension

The following five dimensions are added to the existing 9-dimension schema. Dimensions 1-9 are unchanged. This schema update is a Sprint 0 prerequisite artifact — it must be finalized before any observer or dashboard implementation work begins, regardless of whether a given dimension is MVP or Growth.

```yaml
# .qds/meta/daily/YYYY-MM-DD.yaml
# ... existing dimensions 1-9 unchanged ...

cycle_time:                        # Dimension 10 — FR180 (MVP)
  avg_seconds_by_band:
    small: 14400.0                 # 4h example
    medium: 28800.0                # 8h example
    large: 57600.0                 # 16h example
  anomaly: false

rework_rate:                       # Dimension 11 — FR191 (MVP)
  bmad_caused_rate: 0.12
  qa_caused_rate: 0.08
  hook_caused_rate: 0.03
  ambiguity_caused_rate: null      # null until FR187 live and first record written
  total: 0.23
  anomaly: false

pr_size_distribution:              # Dimension 12 — FR183 (MVP)
  avg_lines_changed: 187.4
  pct_over_threshold: 0.08         # fraction of PRs exceeding configured threshold
  threshold_lines: 300             # snapshot of threshold at observation time
  anomaly: false

defect_escape_rate:                # Dimension 13 — FR185 (Growth)
  rate_90d: 0.02
  numerator: 1                     # PRs tagged caused_production_issue in window
  denominator: 47                  # total merged PRs in window
  anomaly: false

parallelization_yield:             # Dimension 14 — FR186 (Growth)
  utilization_pct: 0.74
  total_wait_minutes: 187.0
  wait_breakdown:
    dependency: 120.0
    contention: 42.0
    capacity: 25.0
  anomaly: false
```

#### Dashboard Additions

The Factory Overview gains a "Metrics" card. The card reads the latest daily journal file on demand — no new SSE channels or WebSocket subscriptions required. The Dashboard Gateway already exposes a `/api/daily-journal/latest` endpoint (or equivalent); the Metrics card is a new consumer of that endpoint.

Card contents:
- Rolling cycle time by band (sparkline, 30d)
- Rework rate gauge (total, with breakdown tooltip)
- PR size histogram (avg lines, % over threshold)
- (Growth) Defect escape rate trend (90d rolling line chart)
- (Growth) Parallelization yield gauge

All data is derived from the daily journal. No pipeline.db queries from the dashboard — the observer is the single aggregation point.

### Trade-off Rationale

**Single aggregation point (daily observer):** Having the dashboard query `pipeline.db` directly would couple the dashboard to the database schema and create concurrent read pressure. The daily observer as single aggregation point means dashboard latency is bounded by journal file read latency (microseconds), not query complexity.

**Complexity band at intake, not retrospectively:** Classifying story complexity at intake (based on declared file count) rather than retrospectively (based on actual lines changed) means the band is available for cycle time normalization from day one, even before the story completes. The approximation is coarse but stable.

**`caused_production_issue` as manual flag:** Automated production issue detection requires integration with incident tracking systems (PagerDuty, Linear, etc.), which is out of scope for MVP and Growth. The manual flag provides an accurate numerator for the defect escape rate at low operational cost. The `qds pr mark-production-issue` command provides a clear, auditable write path.

**Growth dimensions in Sprint 0 schema:** Including FR185 and FR186 journal fields in the Sprint 0 prerequisite schema update, even though their implementation is deferred, prevents a breaking schema change when Growth work begins. Dashboard consumers built against the MVP schema will already have placeholder fields for Growth dimensions.

**`git diff --stat` over provider API:** Git-local diff avoids a network call at PR creation time and works regardless of which Git provider (GitHub, GitLab, self-hosted) the factory is configured against. The trade-off is that the stat reflects the diff against the immediate parent commit, which may differ from the full PR diff if the branch has multiple commits. For PR size awareness (a warning heuristic), this approximation is acceptable.

---

*Session 12 Gap Analysis Response. ADR-025 through ADR-032. These amendments address the two primary weakness clusters identified in the gap analysis: (A) production-readiness of generated code (ADR-026, ADR-031, ADR-032 partial) and (B) trust calibration for autonomous operation (ADR-025, ADR-027, ADR-028, ADR-029). These amendments are authoritative over any contradictory prior text.*
