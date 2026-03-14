# Session 10 Handoff — Code-Lift Manifest Resolution & Doc Amendments

**Date:** 2026-03-14
**From:** Session 9b (Code-Lift Manifest exercise — 6 deep-dive source code analyses, unified manifest, gap/risk validation)
**To:** New conversation for blocker resolution and document amendments
**Goal:** Resolve all 3 blocking items, address all 5 missing stories, amend 4 challenged assumptions, close 10 story-level gaps, and produce updated epics-and-stories-v2.md + architecture-v2.1 amendment notes — making these documents implementation-ready with zero ambiguity

---

## Session 9b Recap: What Was Done

Session 9b conducted a rigorous code-lift validation exercise using GitNexus knowledge graphs across all 6 source repositories. The exercise was executed in two waves of parallel subagents:

**Wave 1 (6 parallel deep-dive agents):** Each agent performed a deep-dive analysis of one source repository, mapping every reusable artifact (functions, types, patterns, schemas) to specific stories in the epic decomposition. All 6 completed successfully:

| Agent | Repository | Key Finding | Reusable LOC |
|-------|-----------|-------------|-------------|
| Overstory | overstory/ | ~5,234 gross / ~3,200 net LOC manifest. SessionStore is the canonical SQLite pattern. 16 type blocks, config loader, watchdog, metrics, merge resolver all mapped. | ~1,150 |
| Pi-mono | pi-mono/ | CRITICAL: Pi has NO native tier concept. `Agent.setModel()` is explicit. `transformContext` and `getApiKey` callbacks are the integration points. | ~170 |
| Superpowers | superpowers/ | 59:1 reuse ratio. Only 2 of 5 functions needed at runtime. CRITICAL: Only `name` and `description` in frontmatter — NO `enforcement` field. | ~210 (import) |
| ZeroClaw | zeroclaw/ | 6 DIRECT_COPY files. SSE uses fetch() not EventSource. WS uses subprotocol auth. 4-item adaptation checklist produced. | ~100 |
| claude-mem | claude-mem/ | MigrationRunner, claim-confirm pattern, ContextBuilder progressive disclosure. | ~120 |
| Research repos | deer-flow, GSD, paperclip, symphony | 20+ design patterns. deer-flow strict-order middleware, GSD Nyquist 3-level, symphony GenServer poll-reconcile-dispatch. | Patterns only |

**Wave 2 (2 parallel synthesis agents):**

| Agent | Deliverable | Location |
|-------|------------|----------|
| Synthesis Manifest | 1,408-line unified code-lift manifest with per-story tables, reuse summary, 10 validated arch decisions, gap analysis, 7-phase implementation priority | `_bmad-output/implementation-artifacts/code-lift-manifest.md` |
| Gap/Risk Validator | 8 validated assumptions, 4 challenged assumptions, 10 story-level gaps, 5 missing stories, 5 risks (2 HIGH, 2 MEDIUM, 1 LOW-MEDIUM) | `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md` |

### Key Metrics

| Metric | Value |
|--------|-------|
| Total estimated LOC (all stories) | ~6,320 |
| Total reusable LOC from source repos | ~1,630 (26%) |
| Net new LOC required | ~4,690 |
| Highest reuse epic | Epic 1 Foundation (69%) |
| Lowest reuse epic | Epic 10 Growth (6%) |
| Stories with zero code-lift | 16 stories (~1,320 LOC, 21%) |
| Blocking items identified | 3 |
| Missing stories identified | 5 |

---

## BLOCKING ITEMS — Must Be Resolved First

### BLOCKER-1: Superpowers `enforcement` Frontmatter Field Does Not Exist (RISK-1 / C-2)

**What's wrong:** The PRD (FR34), Story 2.5 (line 240 of epics-and-stories.md), and multiple architecture references say agents should read "enforcement metadata in YAML frontmatter" from Superpowers skill files. The actual Superpowers source code has exactly TWO frontmatter fields: `name` and `description`. There is no `enforcement` field, no `rules` array, no structured enforcement metadata.

**The contradiction:** ADR-013 (architecture-v2.md lines 838-901) explicitly says "No content validation of skill descriptions — Superpowers owns skill quality. Factory Core consumes frontmatter as-is." This ALREADY implies that `description` is the enforcement metadata. But the PRD and Story 2.5 describe a separate field that doesn't exist.

**What this affects:** Stories 2.5, 2.6, and all gate scripts that reference enforcement rules. If dev agents implement Story 2.5 as written, they will write code to parse a field that does not exist.

**Decision needed:** Choose ONE of:
- **(A) Treat `description` as enforcement text** — Rewrite Story 2.5 AC, add a PRD revision note to FR34, and align with ADR-013's existing "consume as-is" philosophy. This is the simpler path and preserves boundary discipline (Superpowers owns skill quality).
- **(B) Extend Superpowers frontmatter** — Create a prerequisite story to add a structured `enforcement` YAML field to all 14 skill files and update `extractFrontmatter()` in `skills-core.js`. This is more work but gives structured data. Note: this means modifying the Superpowers repo, not just QDS Factory.

**My recommendation:** Option A. ADR-013 already decided this correctly. The description contains natural-language enforcement instructions by design (the 3 critical skills — TDD, verification-before-completion, systematic-debugging — have descriptions that ARE their enforcement rules). Adding a redundant structured field creates maintenance burden with no behavioral benefit.

### BLOCKER-2: No Story Covers Overstory Mail Schema Extension (M-1)

**What's wrong:** Architecture v2 line 280 says "Must extend schema for `learning_report` — Overstory's migration system handles upgrades." The mail system has 12 message types constrained by a CHECK constraint. Adding `learning_report` requires an ALTER TABLE to update the CHECK constraint plus adding a `phase` column per ADR-006 (5d). No story in the epics creates this migration.

**What this blocks:** Story 3.3 (drift warnings via mail), Stories 7.1/7.2 (learning records that may use mail), and FR23/FR57.

**Fix:** Add Story 1.6: "Overstory Schema Extensions" — performs ALL Overstory schema changes using Overstory's native `PRAGMA table_info` probe-then-alter pattern (NOT the Factory Core sequential SQL migration runner):
- Add `learning_report` to mail.db message type CHECK constraint
- Add `phase` column to mail.db per ADR-006 (5d)
- Add `hook_result` and `health_state` to events.db EventType CHECK constraint (needed by Stories 8.8, 3.3)
- Estimated ~40 LOC

This also resolves M-4 (Overstory EventType extensions).

### BLOCKER-3: Missing Factory Core Main Orchestration Loop (RISK-2 / M-3)

**What's wrong:** Story 1.4 creates the process skeleton (startup, config load, DB init). Stories 4.1-4.7 create the turn continuation loop (per-phase agent orchestration). But NO story creates the top-level orchestration loop that:
1. Polls `pipeline.db` for pending/active stories
2. Reconciles current state (which stories are running, which need phase transitions)
3. Dispatches new phase agents via Overstory's `ov sling`
4. Enforces concurrent story limits
5. Handles Factory Core restarts (resume from persisted state)

This is the "brain" of the factory — the Symphony GenServer poll-reconcile-dispatch pattern. Without it, the startup skeleton (1.4) and the turn engine (4.x) are disconnected pieces that cannot operate autonomously.

**Fix:** Add Story 4.0 or expand Story 1.4: "Factory Core Orchestration Loop" — implements the main process loop connecting startup to the turn continuation engine. This story should be sequenced AFTER 1.4 (startup skeleton) and BEFORE 4.1 (turn continuation), serving as the bridge. Estimated ~100-120 LOC.

---

## CHALLENGED ASSUMPTIONS — Corrections Needed

### C-1: Story 2.3 Credential Middleware — Specify `getApiKey` Callback

**Current text:** "beforeModel() configures Pi SDK with the appropriate API credentials for the current agent role without exposing keys in overlay text."

**Problem:** Too vague. Pi SDK's actual mechanism is a `getApiKey` callback function passed to the Agent constructor — not a static configuration property.

**Fix:** Rewrite AC to: "Factory Core registers a `getApiKey` callback with Pi SDK's Agent constructor that returns the appropriate API key for the agent's configured provider. The callback closure captures the key from Factory Core's credential store. No credential material appears in `contextAdditions`, overlay content, or the Agent constructor's configuration object. ADR-008 should reference this callback pattern."

### C-3: Overstory Mail Schema Extension (resolved by BLOCKER-2 fix above)

### C-4: Migration Runner Scope Must Be Explicit

**Current text:** Story 1.2 says "Migrations are plain SQL files executed sequentially by Factory Core at startup."

**Problem:** Could be misinterpreted as applying to ALL databases including Overstory's. Overstory uses a different pattern (`PRAGMA table_info` probe before ALTER TABLE).

**Fix:** Add AC to Story 1.2: "The sequential SQL migration runner manages ONLY Factory Core's own databases (`pipeline.db`, `attribution.db`). Overstory databases (`sessions.db`, `mail.db`, `events.db`, `metrics.db`) use Overstory's native probe-then-alter migration pattern and are managed by the separate Story 1.6 (Overstory Schema Extensions)."

---

## MISSING STORIES — Must Be Added

| ID | Story Name | Epic | LOC | Priority | Rationale |
|----|-----------|------|-----|----------|-----------|
| **1.6** | Overstory Schema Extensions | 1 | ~40 | BLOCKING | Consolidates all Overstory DB schema changes (mail types, events types, phase column) using native probe-then-alter pattern. Resolves BLOCKER-2 and M-4. |
| **2.9** | Pi SDK Tier-to-Model Mapping (TierResolver) | 2 | ~50 | IMPORTANT | Maps Factory Core tier directives (economy/standard/premium) to Pi SDK `Model<Api>` objects via `Agent.setModel()`. Reads mappings from `factory.yaml`, validates at startup against Pi SDK's ModelRegistry. |
| **4.0** | Factory Core Orchestration Loop | 4 (or 1) | ~120 | BLOCKING | Main poll-reconcile-dispatch loop connecting startup skeleton to turn continuation engine. Symphony GenServer pattern. Resolves BLOCKER-3. |
| **9.0** | ZeroClaw Carry-Forward Adaptation | 9 | ~20 | IMPORTANT | Copies 6 files, performs type contract replacement, auth path change (`zeroclaw` -> `.qds/ws-token`), subprotocol rename (`zeroclaw.v1` -> `qds-factory`), base path change (`/_app/` -> `/`). Prerequisite for all Epic 9 stories. |

Note: M-4 (Overstory EventType extensions) is absorbed into Story 1.6.

---

## STORY-LEVEL GAPS — Acceptance Criteria Amendments

These are not missing stories but existing stories with acceptance criteria that need tightening:

| Story | Gap | Amendment |
|-------|-----|-----------|
| **2.1** | `order` field could be misinterpreted as priority/weight | Add AC: "Middleware order is determined by the explicit `order` field (integer) with stable sorting. This is a strict ordering, not a priority system. Middlewares are NOT dynamically reorderable." |
| **2.3** | Vague credential mechanism | See C-1 fix above |
| **2.5** | References nonexistent `enforcement` field | See BLOCKER-1 fix above |
| **3.1** | Doesn't name the three GSD Nyquist verification levels | Add note: "truths = behavioral (substantive), artifacts = existence + content, key_links = wiring. Maps to GSD's three-level Nyquist verification for traceability." |
| **3.4** | AC focuses on structural checks, not goal-first verification | Add AC: "Verification starts from the story's stated goal/purpose and verifies the codebase achieves that purpose. The task checklist is supporting evidence, not the primary verification target." |
| **6.3** | No forward-looking note for multi-process | Add note: "If multi-process Factory Core instances are introduced (Growth), the UNIQUE constraint approach must be revisited in favor of claude-mem's two-phase claim-confirm pattern with `claimed_at` + `confirmed_at` timestamps." |
| **6.1-6.4** | Cost source not explicit | Add AC to Story 6.4: "cost field in cost_events is populated from Pi SDK's `Usage.cost.total`, not recomputed from token counts and rate tables." |
| **9.x** | No ZeroClaw adaptation checklist | Resolved by new Story 9.0 |

---

## RISK REGISTER SUMMARY

| Risk | Severity | Status After This Session |
|------|----------|--------------------------|
| RISK-1: Superpowers enforcement field fiction | HIGH | OPEN — requires design decision (Option A vs B) |
| RISK-2: Missing orchestration loop | HIGH | RESOLVED by new Story 4.0 |
| RISK-3: Pi SDK credential mechanism misunderstood | MEDIUM | RESOLVED by C-1 AC rewrite |
| RISK-4: Overstory schema extensions uncovered | MEDIUM | RESOLVED by new Story 1.6 |
| RISK-5: Migration runner pattern incompatibility | LOW-MEDIUM | RESOLVED by C-4 scope clarification |

---

## What Session 10 Must Do

### Mission: Resolve Blockers, Amend Documents, Produce Implementation-Ready Artifacts

**Job 1: Resolve BLOCKER-1 (Superpowers enforcement field)**
- Make the design decision: Option A (description-as-enforcement) or Option B (extend frontmatter)
- Apply the decision to Story 2.5, PRD FR34, and ADR-013

**Job 2: Apply all corrections to epics-and-stories.md**
- Add Stories 1.6, 2.9, 4.0, 9.0
- Amend acceptance criteria for Stories 2.1, 2.3, 2.5, 3.1, 3.4, 6.3, 6.4
- Add C-4 scope note to Story 1.2
- Update the dependency chain (Story 4.0 becomes prerequisite for 4.1; Story 1.6 becomes prerequisite for 3.3, 8.8; Story 9.0 becomes prerequisite for 9.1)
- Update the FR Coverage Matrix (new stories cover previously uncovered concerns)
- Update the ADR Exercise Matrix
- Update epic LOC totals (Epic 1: 630 -> ~670, Epic 2: 340 -> ~390, Epic 4: 530 -> ~650, Epic 9: 1,100 -> ~1,120)
- Bump document version header

**Job 3: Apply architecture-v2 amendment notes**
- Amend ADR-008 to reference Pi SDK `getApiKey` callback pattern
- Amend ADR-013 to explicitly state `description` IS enforcement metadata (if Option A chosen)
- Add note to state ownership table distinguishing Factory Core migrations from Overstory schema extensions
- No full rewrite needed — produce a concise amendment notes document like Session 8 did

**Job 4: Update code-lift-manifest.md**
- Add entries for new Stories 1.6, 2.9, 4.0, 9.0
- Update Epic subtotals and Section 2 reuse summary table
- Update Section 5 implementation priority order (Story 4.0 inserts between Phase 1 and Phase 3; Story 1.6 adds to Phase 1; Story 9.0 precedes Phase 6)
- Update Section 4 gap analysis (some gap stories now have code-lift references via new stories)

**Job 5: Final cross-validation**
- Every FR in the FR Coverage Matrix has a story
- Every story has unambiguous acceptance criteria with specific Pi SDK / Overstory / Superpowers API references
- Every story's dependencies are satisfiable (no circular deps, no missing prerequisites)
- The 7-phase implementation priority order is consistent with the updated dependency chain
- Risk register shows all 5 risks at RESOLVED or with explicit mitigation plan

---

## File Inventory (What to Read)

**Primary artifacts to modify:**
1. `_bmad-output/implementation-artifacts/epics-and-stories.md` — Epic/story decomposition (1,733 lines)
2. `_bmad-output/implementation-artifacts/code-lift-manifest.md` — Code-lift manifest (1,408 lines)
3. `_bmad-output/implementation-artifacts/code-lift-gap-analysis.md` — Gap analysis (this is the validation source, not a modification target)

**Reference artifacts (read-only):**
4. `_bmad-output/planning-artifacts/architecture-v2.md` — Canonical architecture (consolidated from Sessions 1-9)
5. `_bmad-output/planning-artifacts/prd-v2.md` — Canonical PRD (consolidated from Sessions 1-9)
6. `_bmad-output/planning-artifacts/ux-design-specification-v2.md` — Canonical UX spec

**This handoff document:**
7. `_bmad-output/planning-artifacts/session10-handoff-code-lift-resolution.md` — YOU ARE HERE

---

## Execution Strategy

Use parallel subagents for maximum throughput:

1. **Decision Agent** — Resolve BLOCKER-1 by analyzing Superpowers skill files directly (read the actual `description` fields of the 3 critical skills: TDD, verification-before-completion, systematic-debugging) and confirm Option A is correct
2. **Epics Amendment Agent** — Apply all corrections to `epics-and-stories.md` (new stories, AC amendments, dependency updates, matrix updates)
3. **Architecture Amendment Agent** — Produce concise architecture amendment notes (ADR-008, ADR-013 amendments)
4. **Manifest Update Agent** — Update `code-lift-manifest.md` with new story entries, updated totals, revised priority order
5. **Cross-Validation Agent** — After all amendments land, perform final integrity check: every FR has a story, every story has clear ACs, every dependency is satisfiable, no contradictions between PRD/architecture/epics

**Sequencing:** Agent 1 runs first (decision feeds into Agents 2-4). Agents 2, 3, 4 run in parallel. Agent 5 runs last as final gate.

---

## Quality Bar

This is Session 10 of an adversarial refinement process. The documents produced must meet the following standard:

- **Zero ambiguity in acceptance criteria.** A dev agent reading any story must be able to implement it without asking clarifying questions. Every Pi SDK API, Overstory pattern, and Superpowers function is referenced by its actual name and mechanism.
- **Zero contradictions between documents.** The PRD, architecture, epics, and manifest must tell the same story. If FR34 says "enforcement metadata" and ADR-013 says "description as-is", the conflict must be resolved in ONE direction.
- **Zero orphan dependencies.** Every story's `Dependencies` field must list stories that actually exist. Every prerequisite must be sequenced earlier in the implementation priority order.
- **Traceable code-lift decisions.** Every reuse decision (DIRECT_COPY, ADAPT, PATTERN_COPY, etc.) must reference a specific file path and line range in the source repo. "Inspired by Overstory" is not sufficient — "ADAPT from overstory/src/sessions/store.ts lines 45-120 (WAL setup + migration runner)" is.
- **PhD-level rigor.** If an external reviewer audited these documents, they should find zero logical gaps, zero hand-waving, and zero deferred-to-implementation decisions that should have been made at planning time.
