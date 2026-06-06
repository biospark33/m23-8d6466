---
name: qds-sprint-planning
description: Enterprise-grade story planning workflow with parallel research and parallel writing. Use when planning new epic stories for a single track (A or B). Executes 2-phase core workflow with pre/post phases: Phase 0 (preparation), Phase 1 (parallel research with 5 agents), Phase 2 (parallel story writing with DUAL OUTPUT), and Phase 3 (wrap-up with status updates and PR creation).
version: 1.2.0
author: biospark33
last_updated: 2026-05-16
---

# QDS Sprint Story Planning Skill

A rigorous, guardrailed workflow that orchestrates enterprise-grade story planning through parallel research and parallel writing. Designed for **single-track execution** (either Track A: Backend or Track B: Frontend) to prevent context overflow and ensure story quality.

## Overview

This skill provides a **2-phase core workflow with pre/post phases** that produces stories matching the A6 quality standard:

| Phase | Purpose | Agents |
|-------|---------|--------|
| **Phase 0** (Pre-phase) | Epic & Track Selection | User input validation |
| **Phase 1** (Core) | Parallel Research (5 tracks) | Story patterns, specs, entities/components, dependencies, external libs |
| **Phase 2** (Core) | Parallel Story Writing | Max 2 stories per agent to maintain quality |
| **Phase 2.5** (Gate) | Story Atomicity Audit | Size/SP/DOD/security checks per story — HALT on BLOCK; see `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md` |
| **Phase 3** (Post-phase) | Wrap-up & Updates | Status file updates, PR creation |

### What This Skill Does

- **Accepts epic identifier and track** (e.g., "A7" for Track A, "B3" for Track B)
- **Launches 5 parallel research agents** tailored to track (backend vs frontend)
- **Analyzes dependencies** and recommends wave/batch strategy
- **Launches writing agents** (max 2 stories each) with research context
- **Updates all status files** (epics.md, sprint-status.yaml, CLAUDE.md)
- **Creates PR to dev branch** with commit message

### Single-Track Constraint

**One track at a time only.** This prevents context overflow and ensures the A6 quality bar is met.

| Track | Focus | Epic Examples |
|-------|-------|---------------|
| **Track A** | Backend/Intelligence | A1-A10 (API, agents, database, infrastructure) |
| **Track B** | Frontend/Integration | B1-B10 (UI, components, UX, state) |

## Dynamic Learnings

This skill automatically applies patterns learned from previous sprint planning sessions. Learnings are stored in `.claude/learnings/qds-sprint-planning/` and managed via the `/reflect` command.

### How It Works

When you run `/skills:qds-sprint-planning`, the skill:
1. Loads high-confidence patterns from `patterns.yml` (auto-applied silently)
2. Loads medium-confidence preferences from `preferences.yml` (shown for confirmation)
3. Tracks application statistics for effectiveness measurement

### Managing Learnings

```bash
/reflect status                    # Show all learnings with statistics
/reflect review qds-sprint-planning # Review and promote/demote learnings
/reflect config auto_reflect true  # Enable auto-reflection
```

### Current Learnings

To view current learnings, run `/reflect status qds-sprint-planning` or check the learning files directly:
- `.claude/learnings/qds-sprint-planning/patterns.yml` - High-confidence patterns
- `.claude/learnings/qds-sprint-planning/preferences.yml` - Medium-confidence preferences
- `.claude/learnings/qds-sprint-planning/experimental.yml` - Low-confidence experiments

### Learning Categories

Sprint planning learnings are categorized as:
- **story-estimation**: Points estimation patterns based on story complexity
- **wave-strategy**: Dependency analysis and wave/batch recommendations
- **research-sources**: Which sources provided best quality research
- **spec-references**: Which spec sections are most critical for each track
- **agent-allocation**: Optimal agent-to-story ratios for quality
- **dod-requirements**: DOD checklist patterns for different story types
- **sprint-planning**: Session-level planning heuristics and guardrails

### First-Run Initialization

If `.claude/learnings/qds-sprint-planning/` does not exist, the skill will auto-create the directory and default files (`patterns.yml`, `preferences.yml`, `experimental.yml`) on first run. Initial files will be empty or contain starter comments. You do not need to create the structure manually. Use the `/reflect` command to manage and populate learnings after planning sessions.

## Quick Start

**Note:** Epic IDs and track tokens are case-insensitive (e.g., `A7`/`a7`, `A`/`a`, `B`/`b`). You may use either uppercase or lowercase.

```bash
# Interactive mode (prompts for epic ID and track)
/skills:qds-sprint-planning

# Specify epic, prompts for track
/skills:qds-sprint-planning a7
/skills:qds-sprint-planning b3

# Specify epic and track directly (fastest)
/skills:qds-sprint-planning a7 a
/skills:qds-sprint-planning b3 b

# Resume interrupted workflow
/skills:qds-sprint-planning resume
```

## Enhancement Modes

### Default: `--standard`

When you run `/skills:qds-sprint-planning` without flags, you get `--standard` mode:

- **5 parallel research agents** with track-specific prompts
- **Wave-based writing strategy** based on dependency analysis
- **Full post-writing updates** (epics.md, sprint-status.yaml, CLAUDE.md)
- **Automated PR creation** to dev branch

### Presets

| Preset | Includes | Use Case |
|--------|----------|----------|
| `--minimal` | Core research + writing only | Quick iteration, experienced users |
| `--standard` | Full workflow with updates | **Default** - sprint planning |
| `--full` | standard + spec validation | New epics, complex dependencies |

### Individual Flags

| Flag | Tokens | Description |
|------|--------|-------------|
| `--yolo` | ~0 | Skip all skippable HITL gates (cannot bypass non-skippable gates: Epic/Track Selection, Story Review, Commit Confirmation) |
| `--verbose` | ~500 | Show detailed output from all agents |
| `--dry-run` | ~0 | Run without making changes |

## HITL Gates Summary

| Gate | Phase | Skippable | Purpose |
|------|-------|-----------|---------|
| Epic/Track Selection | 0 | No | Confirm epic and track before starting |
| Research Approval | 1 | Yes (conf >= 0.8) | Approve research findings before writing |
| Story Review | 2 | No | Review each story batch before inserting |
| Commit Confirmation | 3 | No | Approve commit and PR creation |

### Confidence Scoring

The **Confidence Score** displayed in research output (e.g., "Confidence Score: 0.92") is an aggregated heuristic computed from multiple factors to assess research completeness and quality.

**Contributing Factors:**
- **Research Completeness** (30%): Coverage of all required research tracks (patterns, specs, entities/components, dependencies, analysis)
- **Source Reliability** (25%): Quality and recency of source documentation (official specs, published docs, cached resources)
- **Internal Consistency** (20%): Alignment between research tracks (e.g., entity models match database schema)
- **Coverage Depth** (15%): Level of detail in extracted information (schemas, examples, code patterns)
- **Model Confidence** (10%): Automated assessment based on token usage and extraction success

**Scoring Formula:**

```
confidence = (completeness * 0.30) + (reliability * 0.25) + (consistency * 0.20) + (coverage * 0.15) + (model_conf * 0.10)
```

**Score Ranges:**
- **< 0.60**: Low confidence - Research incomplete or inconsistent. Requires manual review before proceeding.
- **0.60 - 0.80**: Moderate confidence - Research adequate but may have gaps. Review recommended.
- **> 0.80**: High confidence - Research comprehensive and consistent. Can skip Research Approval gate.

**Threshold Configuration:**
- Default skip threshold: `0.8` (configured in skill settings)
- Users can override via `--skip-threshold` flag (e.g., `--skip-threshold 0.9` for stricter standard)
- Lowering threshold (e.g., `0.7`) allows faster workflow with increased risk
- Thresholds map directly to the "Research Approval" gate skippability in the table above

## Workflow Phases

### Phase 0: Epic & Track Selection

**What happens:**

1. Parses invocation for epic ID and track
2. **Loads applicable learnings** from `.claude/learnings/qds-sprint-planning/`
   - High-confidence patterns applied automatically
   - Medium-confidence preferences shown for confirmation
3. **No epic provided**: Prompts for epic ID (e.g., "A7", "B3")
4. **No track provided**: Prompts for track ("a" or "b")
5. Validates epic exists in `_bmad-output/epics.md`
6. Detects track from epic prefix or prompts if ambiguous

**HITL Interaction:**

```
🎯 QDS Sprint Story Planning v1.2.0

Epic ID: A7
Track: A (Backend/Intelligence)
Status: Ready for Planning

Stories to plan: [A7.1, A7.2, A7.3, A7.4, A7.5] (5 stories)
Quality Standard: A6 (20-36 DOD checkboxes, Pydantic schemas, 12-Factor compliance)

[p] Proceed with planning
[q] Quit
```

### Phase 1: Parallel Research (5 Tracks)

**5 Research Tracks (executed in parallel via Claude Code Task tool for concurrent agent execution):**

#### Track A (Backend) Research Agents

| Agent | Purpose | Research Focus |
|-------|---------|----------------|
| **Agent 1** | Story Pattern Analysis | Existing A* story templates from epics.md (A5→A6 pattern) |
| **Agent 2** | Tool Specifications | agent-tool-specification.md sections for the epic |
| **Agent 3** | Entity & Database Models | DATABASE_SCHEMA_SPECIFICATION.md, entity patterns from `/services/api-gateway/src/knowledge/entities/` |
| **Agent 4** | External Dependencies | Context7 MCP for latest Python/SDK docs (Claude SDK, FastAPI, etc.) |
| **Agent 5** | Dependency Analysis | Story sequencing, wave/batch strategy from epics.md |

#### Track B (Frontend) Research Agents

| Agent | Purpose | Research Focus |
|-------|---------|----------------|
| **Agent 1** | Story Pattern Analysis | Existing B* story templates from epics.md (B5→B6 pattern) |
| **Agent 2** | UX/UI Specifications | ux-design-specification.md sections for the epic |
| **Agent 3** | shadcn Component Research | **shadcn MCP server** for latest/tested components, blocks, themes |
| **Agent 4** | React/Next.js Patterns | Context7 MCP for React, Next.js, CopilotKit, TailwindCSS patterns |
| **Agent 5** | Dependency Analysis | Story sequencing, wave/batch strategy from epics.md |

**Each research agent produces:**

- Structured report with file paths
- Patterns, schemas, and findings
- Specific to track (backend vs frontend)
- Ready for insertion into writing agent prompts
- **Incorporates learned patterns** from previous planning sessions (story estimation, wave strategy, research sources)

### Phase 2: Parallel Story Writing (Waves, Max 2 Stories Per Agent)

After research completes:

1. **Extract sprint number** from epic context (e.g., Epic A6 → Sprint 7, Epic B6 → Sprint 7)
2. **Create sprint-specific directory**: `_bmad-output/sprint-artifacts/sprint-{N}/stories/`
3. **Determine wave strategy** based on Agent 5's dependency analysis
4. **Launch writing agents** with max 2 stories each (context quality degrades beyond that)
5. **Each writing agent produces TWO outputs:**
   - **Output 1 (Detailed)**: Full enterprise-grade story file → `sprint-{N}/stories/{story-slug}.md`
   - **Output 2 (Brief)**: Epic summary with link → for insertion into `epics.md`

**Example wave pattern:**
- Wave 1: Stories A7.1, A7.2 (independent) → 1 agent
- Wave 2: Stories A7.3, A7.4 (depend on A7.1) → 1 agent
- Wave 3: Story A7.5 (standalone) → 1 agent

### Sprint Number Mapping

Epic-to-sprint mapping is derived from `_bmad-output/epics.md`:

| Epic | Sprint | Story Directory |
|------|--------|-----------------|
| A1-A2 | Sprint 1 | `_bmad-output/sprint-artifacts/sprint-1/stories/` |
| B1-B2 | Sprint 2 | `_bmad-output/sprint-artifacts/sprint-2/stories/` |
| B2.5 | Sprint 3 | `_bmad-output/sprint-artifacts/sprint-3/stories/` |
| A3 | Sprint 4 | `_bmad-output/sprint-artifacts/sprint-4/stories/` |
| A4 | Sprint 5 | `_bmad-output/sprint-artifacts/sprint-5/stories/` |
| A5, B5 | Sprint 6 | `_bmad-output/sprint-artifacts/sprint-6/stories/` |
| A6-A7, B6-B7 | Sprint 7 | `_bmad-output/sprint-artifacts/sprint-7/stories/` |
| I1 | sprint-infra | `_bmad-output/sprint-artifacts/sprint-infra/stories/` |

**Extraction Pattern:**

The sprint number is extracted using the following deterministic resolution steps (in order):

1. **Check explicit mapping table**: Look up the epic identifier in the mapping table above (A1-A7, B1-B7, I1) and return the associated sprint.

2. **Search epics.md**: If not found in the table, parse `_bmad-output/epics.md` for the epic identifier and extract sprint context from the epic header.

3. **Scan sprint-artifacts directories**: If still not found, scan `_bmad-output/sprint-artifacts/` directories for matching story files (e.g., search `sprint-*/stories/` for filenames or front-matter containing the epic identifier like "A7", "B3", or "I1") and return that sprint if present. Note: Match whole epic codes (A1-A7, B1-B7, I1) rather than partial substrings.

4. **Apply default rule**: For new epics without existing sprint directories, assign to the "next available sprint" by taking the highest **numeric** `sprint-{N}` directory under `_bmad-output/sprint-artifacts` (ignore `sprint-infra` and any non-numeric names) and incrementing it. If no numeric sprint directories exist (empty set), default to `sprint-1` for regular epics or `sprint-infra` for infrastructure epics.

**Note:** If no sprint is found and the epic identifier fails Phase 0 validation (referencing the "Phase 0 validation" check at line 179), the system surfaces a validation error and asks the user to correct the epic rather than silently assigning a sprint. If the epic passes validation but truly has no matching artifacts in `_bmad-output/epics.md` or `_bmad-output/sprint-artifacts`, then the "next available sprint" rule (highest numbered sprint directory incremented) or `sprint-infra` fallback for infrastructure epics applies.

### Phase 2.5: Story Atomicity Audit (Gate before Phase 3)

**See:** `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md`
for the full check definition and report format.

After Phase 2 writes all stories and BEFORE Phase 3 wrap-up, every story
file produced by this run is audited against eight atomicity checks:

1. Normative-content size ≤ 200 lines (BLOCK at >250)
2. Total file size ≤ 400 lines (WARN)
3. SP budget ≤ 8 SP (BLOCK)
4. DOD checkbox count ≤ 10 high-signal items (WARN; remove project-wide
   CI invariants like `ruff clean`, `tests pass`, `mypy clean`)
5. Title `AND` connectors ≤ 1 (WARN)
6. Blocker markers (`⛔` / `pending sign-off` / `TBD on`) = 0 (BLOCK)
7. `## Files to Modify` section present + ≤ 10 unique files (BLOCK if absent)
8. `## Security Invariants` section required when ANY of these keyword
   classes appear (BLOCK if triggered+absent):
   - RLS / row-level security / policy
   - migration / DDL / schema change / alembic
   - auth / authentication / authorization / RBAC / capability / scope / permission
   - encryption / secrets / KMS / vault / credential
   - PII / personal data / GDPR / HIPAA
   - payment / billing / financial / PCI
   - tenant / multi-tenancy / cross-tenant
   - upload / file handling / deserialization / parse

**Output:** `_bmad-output/sprint-artifacts/sprint-{N}/atomicity-audit-{YYYY-MM-DD}.md`

**HALT behavior:** If any BLOCK-severity finding lacks an operator
override entry in the report's "Override log" section, the workflow
halts before Phase 3. WARN findings are reported but non-blocking.

**Cross-skill contract:** The keyword list in check 8 must match
`bmad-create-story` template (#1433) and
`bmad-check-implementation-readiness` (#1431) verbatim.

### Phase 3: Post-Writing Updates

After all stories complete:

**0. Adversarial Auto-Iteration (MANDATORY — runs BEFORE any commit/PR step below).**

Before any of the file-write / commit / PR steps in this phase, run the
adversarial-review iteration loop documented in
[`.claude/skills/qds-sprint-planning/steps/phase-3-wrap-up.md`](../../skills/qds-sprint-planning/steps/phase-3-wrap-up.md).

The loop:

- Scans every Phase 2 story file + the epic definition for **domain
  triggers** (rls, migration, auth, secrets, upload, deserialization,
  file handling, …) and loads matching checklists from
  `.claude/skills/qds-sprint-planning/checklists/<domain>.md` as the
  `also_consider` payload for the review agent.
- Invokes `bmad-review-adversarial-general` against each story
  individually + the cross-story consistency view + the
  sprint-status.yaml entries + the targeted epic block.
- Categorizes findings into **HIGH** (structural), **MEDIUM**
  (clarity), **LOW** (nits).
- Exits when `HIGH == 0 AND MEDIUM <= 3` (typically converges in 2–3
  iterations on a well-researched epic).
- Applies findings automatically only for iterations 1–2 as an
  in-place re-write pass — **NOT a separate commit**; integrated into
  the same Phase 2 output that steps 1–8 below will commit. Iteration
  3 does **not** auto-apply: it surfaces a disposition table and
  HALTs (see next bullet).
- If iteration 3 ends with surviving HIGH or > 3 MEDIUM findings,
  surfaces a disposition table to the operator and **HALTs** the
  wrap-up until the operator chooses
  `[a]pply` / `[r]e-iterate` / `[e]dit` / `[q]uit`.

The adversarial-review log (counts per iteration, dispositions taken,
which domain checklists fired) is appended to the wrap-up commit's PR
body so reviewers see what was caught pre-CR.

> **Why this exists.** Single-shot adversarial review left structural
> issues on the floor in Epic RBAC-1 that took 50+ subsequent CR/Gemini
> rounds to surface. Auto-iteration converges before commit. See
> `_bmad-output/sprint-artifacts/sprint-62/epic-rbac-1-retro-skill-audit-2026-05-13.md`
> §4.5 and pattern SPL-024 in `patterns.yml`.

1. **Create individual story files** in `sprint-{N}/stories/` directory:
   - Each story file contains FULL enterprise-grade detail
   - File naming: `{story-slug}.md` (e.g., `a7-1-writing-agent.md`)
   - Use `Write` tool to create files at `_bmad-output/sprint-artifacts/sprint-{N}/stories/{story-slug}.md`

2. **Update `_bmad-output/epics.md`** with BRIEF summaries:
   - Each story entry includes `**Story File:**` link to individual story file
   - Brief user story (As a **Role**, I want Feature, So that Value)
   - Bulleted AC summary (not full Given/When/Then)
   - Brief technical notes
   - Brief DOD checklist
   - Link to full detail: `**Full enterprise detail** is in the individual story file linked above.`

3. **Update `_bmad-output/sprint-artifacts/sprint-status.yaml`**:
   - Epic status → `ready-for-dev`
   - Story statuses → `ready-for-dev`

4. **Update `/CLAUDE.md`** current status line

5. **Create feature branch**: `feature/epic-{EPIC}-stories`

6. **Commit**: `feat(epic-{EPIC}): write enterprise-grade stories`

7. **Push** to remote

8. **Create PR** to `dev` branch (PR body includes the adversarial-review iteration log from Step 0)

9. **Save session transcript** for reflection analysis (used by `/reflect` to extract learnings)

   **Transcript Storage:**
   - **Location**: `.claude/learnings/qds-sprint-planning/transcripts/`
   - **Filename format**: `YYYY-MM-DD_HHMMSS_<session-description>.md`
   - **How to save**: Manually copy the Claude Code session conversation into a new file in the transcripts directory
   - **Example**: `.claude/learnings/qds-sprint-planning/transcripts/2026-02-02_143000_A7-planning-session.md`

   **⚠️ IMPORTANT REMINDER**: Don't forget to save the session transcript! Use this quick command after planning completes:

   ```bash
   # Create transcript file with current timestamp
   # Note: This format works on both Linux (GNU date) and macOS (BSD date)
   mkdir -p .claude/learnings/qds-sprint-planning/transcripts
   TIMESTAMP=$(date +%Y-%m-%d_%H%M%S)
   echo "# ${TIMESTAMP}_Epic-{EPIC}-planning.md" > .claude/learnings/qds-sprint-planning/transcripts/${TIMESTAMP}_Epic-{EPIC}-planning.md
   # Then paste the conversation into the file
   ```

   **Consumer:** The `/reflect` command reads from `transcripts/` to extract learnings. Ensure:
   - File extension is `.md`, `.txt`, or `.transcript`
   - Use role markers (`user:`, `assistant:`, `system:`) for proper parsing
   - Place files in `.claude/learnings/<skill>/transcripts/` structure

## Research Agent Prompt Templates

### Agent 1 - Story Pattern Research

```
You are analyzing existing story patterns for Epic {EPIC} from _bmad-output/epics.md.

Extract the story template structure including:
- Story title format (### Story {EPIC}.X: [Title])
- User story format (As a **[Role]**, I want [Feature], So that [Value])
- Acceptance Criteria (Given/When/Then scenarios)
- Overview section format
- Technical Notes format
- 12-Factor Agent Compliance items
- Definition of Done categories and checklist items

Output: A complete story template that matches the established pattern for this track.

Return ONLY the template structure with placeholders like {STORY_ID}, {TITLE}, {POINTS}, etc.
```

### Agent 2 - Tool Specifications (Track A) / UX Specifications (Track B)

**Track A:**

```
Research tool specifications from _bmad-output/agent-tool-specification.md for Epic {EPIC}.

Extract:
- Tool names (e.g., pricing.pricing_calculator)
- Tool descriptions
- Input schemas (Pydantic models with Field descriptions)
- Output schemas (Pydantic models)
- Any security or validation requirements

Output: Structured tool specification report with complete Pydantic schemas.
```

**Track B:**

```
Research UX/UI specifications from _bmad-output/ux-design-specification.md for Epic {EPIC}.

Extract:
- Screen layouts and component requirements
- Design tokens (colors, typography, spacing)
- User flows and interactions
- Accessibility requirements
- shadcn/ui components to use

Output: Structured UX specification report with component mappings.
```

### Agent 3 - Entity & Database (Track A) / shadcn Components (Track B)

**Track A:**

```
Research database schema and entity models for Epic {EPIC}.

Read:
- _bmad-output/specifications/DATABASE_SCHEMA_SPECIFICATION.md
- services/api-gateway/src/knowledge/entities/ (entity models)
- services/api-gateway/src/schemas/ (Pydantic request/response schemas, optional supplemental)
- **services/api-gateway/src/database/models/ (ORM models — authoritative source of record for entity/table definitions)**
- **services/api-gateway/src/database/migrations/versions/ (Alembic version migrations — authoritative source of record for schema changes and versioning)**

Extract:
- Relevant database tables and their schemas
- Entity models with their fields and relationships
- Bi-temporal patterns if applicable
- Multi-tenant isolation patterns

**Important:** The ORM model package (`src/database/models/`) is the canonical source of truth for table-level entity definitions and relationships. The migration artifacts (`src/database/migrations/versions/`) are the canonical source for schema evolution and versioning. Consult these alongside `DATABASE_SCHEMA_SPECIFICATION.md` to ensure research reflects the actual DB state.

Output: Database and entity patterns report with file paths and schema details.
```

**Track B:**

```
Use the shadcn MCP server to research the latest and most tested components for Epic {EPIC}.

Query shadcn for:
- Components relevant to the epic's features
- Available blocks that match user flow requirements
- Theme and styling patterns
- Best practices for component composition

Output: shadcn component report with component names, props, and usage examples.
```

### Agent 4 - External Dependencies

**Track A:**

```
Use Context7 MCP to find latest documentation for libraries needed for Epic {EPIC}.

Focus on:
- Claude Agent SDK (latest version, patterns)
- FastAPI (best practices, new features)
- Pydantic v2 (schema patterns)
- PostgreSQL/pgvector (query patterns)
- Other Python dependencies relevant to the epic

Output: External dependencies report with versions, API patterns, and code examples.
```

**Track B:**

```
Use Context7 MCP to find latest documentation for libraries needed for Epic {EPIC}.

Focus on:
- Next.js 15 (App Router patterns)
- React 19 (new features, hooks)
- CopilotKit (integration patterns)
- TailwindCSS (utility patterns)
- shadcn/ui (component patterns)
- Other frontend dependencies relevant to the epic

Output: External dependencies report with versions, API patterns, and code examples.
```

### Agent 5 - Dependency Analysis

```
Analyze dependencies between stories in Epic {EPIC} from _bmad-output/epics.md.

Determine:
- Which stories are independent (can be written in parallel)
- Which stories depend on others (must wait)
- Recommended wave/batch strategy
- Optimal agent allocation (max 2 stories per agent)

Output: Dependency analysis with:
- Story list with dependency graph
- Wave/batch recommendations
- Suggested agent assignments
- Total expected points estimate
```

## Writing Agent Template

```
You are writing enterprise-grade user stories for Epic {EPIC} ({TRACK}: {TRACK_NAME}).

## Stories to Write

You will write {STORY_COUNT} stories in this batch:
{STORY_LIST}

## Sprint Context

- **Sprint Number**: {SPRINT_NUM}
- **Story Directory**: `_bmad-output/sprint-artifacts/sprint-{SPRINT_NUM}/stories/`
- **Story File Pattern**: `{story-slug}.md`

The `{story-slug}` is derived from the story ID and title:
- Format: `{epic-lower}-{num}-{title-kebab-case}.md`
- Example: Story `A7.1` with title "Writing Agent" → `a7-1-writing-agent.md`
- Example: Story `B3.2` with title "Question Edit Flow" → `b3-2-question-edit-flow.md`

To generate: (1) lowercase the epic letter/number, (2) replace the dot with a dash, (3) append a dash, (4) convert the title to kebab-case.

## Research Context

### Story Template (from Agent 1)
{STORY_TEMPLATE}

### Tool/UX Specifications (from Agent 2)
{TOOL_UX_SPECS}

### Entity/Component Patterns (from Agent 3)
{ENTITY_COMPONENT_PATTERNS}

### External Dependencies (from Agent 4)
{EXTERNAL_DEPENDENCIES}

### Dependency Analysis (from Agent 5)
{DEPENDENCY_ANALYSIS}

## Quality Requirements

Every story MUST include:

1. **Header with spec reference**: `**Spec Reference:** [SPEC_FILE.md] §[SECTION]`
2. **User story format**: As a **[Role]**, I want [Feature], So that [Value]
3. **Overview section**: Technical overview with key patterns
4. **Acceptance Criteria**: Given/When/Then scenarios
5. **Technical Notes**: Model config, file structure, integration points
6. **12-Factor Agent Compliance** (Track A) or UI Compliance (Track B)
7. **Definition of Done**: 20-36 DOD checkboxes across 6 categories:
   - Implementation (6-10 items)
   - Testing (4-7 items)
   - Code Quality (3-5 items)
   - Documentation (2-5 items)
   - Dependencies (2-5 items)
   - Integration (3-4 items)

## Dual Output Pattern (CRITICAL)

You MUST produce TWO outputs for each story:

### Output 1: Individual Story File (Detailed)

Create a standalone file at `_bmad-output/sprint-artifacts/sprint-{SPRINT_NUM}/stories/{story-slug}.md` containing:

- Full enterprise-grade story with all details
- Complete Acceptance Criteria with Given/When/Then scenarios
- Full Technical Notes section
- Complete API contracts/Pydantic schemas (Track A) or component tables (Track B)
- Full 12-Factor Agent Compliance or UI Compliance section
- Complete Definition of Done with all checkboxes
- All subsections and details

### Output 2: Epic Summary (Brief)

For insertion into `_bmad-output/epics.md`, produce a brief summary:

```markdown
### Story {EPIC}.{NUM}: {Title}

**Story File:** [`sprint-artifacts/sprint-{SPRINT_NUM}/stories/{story-slug}.md`](./sprint-artifacts/sprint-{SPRINT_NUM}/stories/{story-slug}.md)

As a **[Role]**,
I want [Feature],
So that [Value].

**Story Points:** {POINTS}

**Acceptance Criteria:**

- [Bullet point summary of AC1]
- [Bullet point summary of AC2]
- [... additional AC bullets]

**Technical Notes:**

- [Brief technical note 1]
- [Brief technical note 2]

**Definition of Done:**

- [ ] [Brief DOD item 1]
- [ ] [Brief DOD item 2]
- [... additional DOD bullets]

**Full enterprise detail** (AC1-ACN with scenarios, API contracts, detailed DOD)
is in the individual story file linked above.
```

## Output Format

1. First, use the `Write` tool to create the detailed story file
2. Then, provide the brief summary for epics.md insertion
3. After writing each story batch, pause for confirmation before continuing

Follow the A6 story quality standard exactly.
```

## Quality Bar (A6 Reference)

The A6 stories are the reference standard. All new stories must match this quality:

| Story | Points | DOD Checklists | Key Features |
|-------|--------|----------------|--------------|
| A6.1: Pricing Agent | 8 | 31 checkboxes | Volume tiers, bundle discounts, sales escalation |
| A6.2: Compliance Agent | 5 | 28 checkboxes | Framework mapping, Gate 3 trigger |
| A6.3: Pricing Tools | 5 | 33 checkboxes | ToolPort abstraction, Pydantic schemas |
| A6.4: Compliance Tools | 3 | 21 checkboxes | @tool decorator, shared tools |
| A6.5: Workbook Ingestion | 8 | 36 checkboxes | Docling, pandas, bi-temporal storage |

**Every story must have:**
- 20-36 DOD checkboxes across 6 categories (20-30 for standard stories, up to 36 for complex stories)
  - Treat stories with 5+ story points, multiple external integrations, cross-team impacts, or significant architectural changes as complex and target 30–36 checkboxes; otherwise target 20–30
- Full spec references with section numbers
- Pydantic schemas with Field descriptions (Track A) or component specs (Track B)
- 12-Factor Agent compliance items (Track A) or UI compliance (Track B)
- Security requirements where applicable
- Performance targets where applicable
- File structure with paths
- Integration points documented

## Track A vs Track B Story Differences

| Aspect | Track A (Backend) | Track B (Frontend) |
|--------|------------------|-------------------|
| **Spec References** | agent-tool-specification.md, DATABASE_SCHEMA_SPECIFICATION.md | ux-design-specification.md |
| **Story Sections** | Agent Tools table with Pydantic schemas | Component table with shadcn mappings |
| **Technical Notes** | Model config, file structure, security requirements | Screen layouts, user flows, accessibility |
| **Compliance** | 12-Factor Agent Compliance (III, VI, XI, etc.) | UI Compliance (responsive, a11y, i18n) |
| **DOD: Testing** | Unit, integration, security, performance tests | E2E tests, Storybook, accessibility tests |
| **DOD: Code Quality** | mypy strict, ruff, Pydantic schemas | ESLint, TypeScript, component types |
| **DOD: Integration** | ToolPort, StatePort, orchestrator routing | AG-UI events, CopilotKit hooks, state sync |

## Post-Writing Updates Checklist

After all stories complete:

- [ ] **Adversarial review converged** (HIGH == 0, MEDIUM <= 3) per
      `steps/phase-3-wrap-up.md`. Iteration log captured for the PR body.
- [ ] **Domain checklists logged** (which `checklists/<domain>.md` files
      fired, which trigger words matched, which artifacts they were
      applied to).
- [ ] **Individual story files created** in `_bmad-output/sprint-artifacts/sprint-{N}/stories/`
  - Each file contains FULL enterprise-grade detail
  - File naming follows `{story-slug}.md` pattern
  - Verify: `ls _bmad-output/sprint-artifacts/sprint-{N}/stories/`
- [ ] **epics.md updated** with BRIEF summaries only
  - Each story has `**Story File:**` link to individual story file
  - AC summaries are bulleted, not full Given/When/Then
  - Technical notes are brief
  - Verify: `grep -c "Story File:" _bmad-output/epics.md` shows count >= story count
- [ ] **Epic header updated** with story count, points total, duration
- [ ] **sprint-status.yaml updated**:
  - Epic status → `ready-for-dev`
  - All story statuses → `ready-for-dev`
  - Points assigned to each story
- [ ] **CLAUDE.md updated** with new epic status in current status line
- [ ] **Feature branch created**: `feature/epic-{EPIC}-stories`
- [ ] **Commit created**: `feat(epic-{EPIC}): write enterprise-grade stories`
- [ ] **Pushed to remote**
- [ ] **PR created** to `dev` branch with description linking to epic

## Verification Rules (Run After Planning)

After the skill completes, run these checks to verify the fix:

```bash
# Rule 1: Story files are in sprint-N/stories/ (not generic /stories)
# Note: sprint-infra is a valid location for infrastructure stories
# Check if any stories exist in top-level stories folder (should be empty)
if find _bmad-output/sprint-artifacts/stories -name "*.md" -print -quit 2>/dev/null | grep -q .; then
  echo "FAIL: Stories in generic /stories folder"
else
  echo "PASS: No story markdown files in _bmad-output/sprint-artifacts/stories"
fi

# Rule 2: Each story has a "Story File:" link in epics.md
LINK_COUNT=$(grep -c "Story File:" _bmad-output/epics.md || echo "0")
echo "Found $LINK_COUNT story file links"
if [ "$LINK_COUNT" -lt 1 ]; then
  echo "FAIL: No story file links found"
else
  echo "PASS: Stories have file links"
fi

# Rule 3: epics.md is not bloated with full story detail
LINE_COUNT=$(wc -l < _bmad-output/epics.md)
echo "epics.md has $LINE_COUNT lines"
if [ "$LINE_COUNT" -gt 10000 ]; then
  echo "WARN: epics.md is large: $LINE_COUNT lines"
else
  echo "PASS: epics.md size reasonable"
fi
```

## Examples

### Example 1: Standard Track A Planning

```bash
/skills:qds-sprint-planning a7 a
```

Output:

```
🎯 QDS Sprint Story Planning v1.2.0

Phase 0: Epic & Track Selection
  ✅ Epic: A7 (Writing + QA Agents)
  ✅ Track: A (Backend/Intelligence)
  ✅ Stories: 5 stories (29 estimated points)

Phase 1: Parallel Research (5 agents)
  ✅ Agent 1: Story patterns extracted from A5, A6
  ✅ Agent 2: Tool specs from agent-tool-specification.md §6-7
  ✅ Agent 3: Entity patterns from DATABASE_SCHEMA_SPECIFICATION.md
  ✅ Agent 4: External deps (Claude SDK, Python patterns)
  ✅ Agent 5: Dependency analysis (2 waves recommended)

  Confidence Score: 0.92

Phase 2: Story Writing (Wave 1)
  ✅ Writing A7.1: Writing Agent (8 pts)
  ✅ Writing A7.2: QA Agent (5 pts)

  [Detailed stories written to _bmad-output/sprint-artifacts/sprint-7/stories/]
  [Brief summaries written to _bmad-output/epics.md with Story File links]

Phase 3: Updates
  ✅ epics.md updated
  ✅ sprint-status.yaml updated
  ✅ CLAUDE.md updated
  ✅ Branch: feature/epic-a7-stories
  ✅ Commit: feat(epic-a7): write enterprise-grade stories

🎯 PR Created: https://github.com/biospark33/RFP-Agents/pull/XXX
```

### Example 2: Track B with shadcn Research

```bash
/skills:qds-sprint-planning b4 b
```

Output:

```
🎯 QDS Sprint Story Planning v1.2.0

Phase 0: Epic & Track Selection
  ✅ Epic: B4 (Question Management Flow)
  ✅ Track: B (Frontend/Integration)
  ✅ Stories: 4 stories (22 estimated points)

Phase 1: Parallel Research (5 agents)
  ✅ Agent 1: Story patterns extracted from B2, B3
  ✅ Agent 2: UX specs from ux-design-specification.md
  ✅ Agent 3: shadcn components (DataTable, Dialog, Form)
  ✅ Agent 4: React/Next.js patterns from Context7
  ✅ Agent 5: Dependency analysis (2 waves recommended)

Phase 2: Story Writing
  ✅ Writing B4.1: Question List (5 pts)
  ✅ Writing B4.2: Question Detail (5 pts)
  ✅ Writing B4.3: Question Edit (6 pts)
  ✅ Writing B4.4: Bulk Operations (6 pts)

Phase 3: Updates
  ✅ All status files updated
  ✅ PR created to dev branch
```

## State Persistence

**Location:** `_bmad-output/workflow-state/qds-sprint-planning/{epic}-{track}/`

The workflow saves state after each phase:

- Current phase and completed phases
- Epic and track identifiers
- Research results (cached)
- Wave strategy and agent assignments
- Stories written so far

Enable resumption with `/skills:qds-sprint-planning resume`.

## Integration with Other Skills

This skill complements:

- `qds-dev` - Story development workflow (uses stories created by this skill)
- `qds-retro` - Sprint retrospectives (lessons feed back into planning)
- `sc:implement` - General implementation skill (qds-sprint-planning creates stories for implementation)

## Troubleshooting

### Research Agent Failures

If a research agent fails:

1. Check MCP server status (Context7, shadcn)
2. Use `--verbose` to see detailed errors
3. Re-run with `/skills:qds-sprint-planning {epic} {track}` to retry

### Context Overflow

If context overflow occurs:

1. Reduce wave size (fewer stories per agent)
2. Use `--minimal` to skip spec validation
3. Plan epic in multiple runs (subset of stories each time)

### shadcn MCP Unavailable

If shadcn MCP is not available for Track B:

1. Agent 3 falls back to reading `_bmad-output/ux-design-specification.md`
2. Component patterns inferred from existing B* stories
3. Warning logged but workflow continues

### Context7 MCP Unavailable

If Context7 MCP is not available:

1. Agent 4 falls back to reading local documentation directories
2. Searches for cached SDK docs in `_bmad-output/` or `docs/`
3. Flags missing external dependency documentation for manual research
4. Warning logged but workflow continues with reduced external context

## Dependencies

- Git >= 2.30 (for branch management)
- GitHub CLI (`gh`) >= 2.0 (for PR creation)
- Context7 MCP server (for library research, has fallback if unavailable)
- shadcn MCP server (for Track B component research, optional but recommended)
- Claude Code Task tool (for parallel agent execution)

## Changelog

### [1.2.0] - 2026-05-16

**Adversarial review auto-chain + domain-checklist plugins** (resolves #1432)

- **Added**: `steps/phase-3-wrap-up.md` — mandatory pre-commit
  adversarial-iteration loop (max 3 iterations) that invokes
  `bmad-review-adversarial-general` against story files (each + cross-
  story consistency), `sprint-status.yaml` entries, and the targeted
  epic block in `epics.md`. Converges when `HIGH == 0 AND MEDIUM <= 3`;
  surfaces a disposition table to the operator if iteration 3 fails to
  converge.
- **Added**: `checklists/` directory with pluggable domain checklists.
  Shipped in this release: `rls-invariants.md`, `migration-invariants.md`,
  `auth-invariants.md`, `secrets-invariants.md`, `input-invariants.md`.
  Deferred to a follow-up: `pii-invariants.md`, `payments-invariants.md`.
- **Added**: Domain-trigger detection in Phase 3 Step 0 — scans every
  Phase 2 story file + the epic definition for trigger keywords (`rls`,
  `migration`, `alembic`, `auth`, `rbac`, `capability`, `encryption`,
  `secrets`, `KMS`, `vault`, `upload`, `deserialization`, `file
  handling`) and loads matching checklists as `also_consider` for the
  review agent.
- **Updated**: Post-Writing Updates Checklist now includes
  adversarial-convergence + domain-checklist-log items.
- **Pattern**: Logged as `SPL-024: Auto-iterate adversarial review
  until findings stabilize` in `patterns.yml`.
- **Source**: Epic RBAC-1 retro skill audit §4.5 — single-shot
  adversarial review missed structural issues that took 50+ subsequent
  CR/Gemini rounds to surface.

### [1.1.0] - 2026-02-03

**CRITICAL FIX**: Dual output pattern for story organization

- **Added**: Sprint number extraction from epic context
- **Added**: Story files now created in `sprint-{N}/stories/` directories (not generic `/stories`)
- **Added**: Dual output pattern:
  - Output 1: Full enterprise-grade detail in individual story files
  - Output 2: Brief summaries in `epics.md` with `Story File:` links
- **Fixed**: `epics.md` bloat issue - no longer contains full story detail
- **Added**: Sprint-to-epic mapping table in skill documentation
- **Added**: Verification rules to run after planning completes
- **Updated**: Writing agent template with dual output instructions
- **Updated**: Post-writing checklist with verification steps

This fix ensures:
- Stories are properly organized by sprint
- `epics.md` remains a readable index/table of contents
- Full enterprise detail lives in individual story files
- Consistent pattern with existing B4, B7, A6 stories

### [1.0.0] - 2026-02-02

- Initial release
- 2-phase core workflow with pre/post phases (Phase 0: selection, Phase 1: research, Phase 2: writing, Phase 3: wrap-up)
- Parallel research (5 agents) and parallel writing (max 2 stories per agent)
- Single-track constraint (A or B, not both)
- Track-specific research prompts (backend vs frontend)
- shadcn MCP integration for Track B
- Automated post-writing updates
- PR creation to dev branch
- `--yolo` flag skips only skippable HITL gates (cannot bypass non-skippable gates)
