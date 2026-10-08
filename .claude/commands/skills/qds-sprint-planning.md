---
name: qds-sprint-planning
description: Enterprise-grade story planning workflow with parallel research and parallel writing. Use when planning new epic stories for a single track (one epic family — the track scheme is project-defined; in QDS-Factory it is the epic prefix, e.g. P0, P1, DF*, SC*). Executes 2-phase core workflow with pre/post phases: Phase 0 (preparation), Phase 1 (parallel research with 5 agents), Phase 2 (parallel story writing with DUAL OUTPUT), and Phase 3 (wrap-up with status updates and PR creation).
version: 1.5.0
author: biospark33
last_updated: 2026-10-03
---

# QDS Sprint Story Planning Skill

A rigorous, guardrailed workflow that orchestrates enterprise-grade story planning through parallel research and parallel writing. Designed for **single-track execution** (one epic family at a time) to prevent context overflow and ensure story quality. The track scheme is project-defined: in QDS-Factory a track is the epic prefix (P0, P1, DF*, SC*, or the v6 codes Z/M/A/J/G), resolved from `.qds-config.yml` (`qds.paths.bmad_dir`) and the epic index.

## Overview

This skill provides a **2-phase core workflow with pre/post phases** whose DoD bar is the Phase 2.5 atomicity gate:

| Phase | Purpose | Agents |
|-------|---------|--------|
| **Phase 0** (Pre-phase) | Epic & Track Selection | User input validation |
| **Phase 1** (Core) | Parallel Research (5 tracks) | Story patterns, specs, entities/components, dependencies, external libs |
| **Phase 2** (Core) | Parallel Story Writing | Max 2 stories per agent to maintain quality |
| **Phase 2.5** (Gate) | Story Atomicity Audit | Size/SP/DOD/security checks per story — HALT on BLOCK; see `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md` |
| **Phase 3** (Post-phase) | Wrap-up & Updates | Status file updates, PR creation |

### What This Skill Does

- **Accepts epic identifier** (e.g., "DF4", "P1"); the track is the epic prefix
- **Launches 5 parallel research agents** (backend variant by default; frontend variant for epics targeting `visualizer/`)
- **Analyzes dependencies** and recommends wave/batch strategy
- **Launches writing agents** (max 2 stories each) with research context
- **Updates all status files** (epic index, sprint-status.yaml)
- **Creates PR to dev branch** with commit message

### Single-Track Constraint

**One track at a time only.** This prevents context overflow and keeps stories inside the Phase 2.5 gate.

A track is the epic prefix. Resolve the epic index from `.qds-config.yml` (`qds.paths.bmad_dir`, default `_bmad-output`): use the `index:` key in `{bmad_dir}/sprint-artifacts/sprint-status.yaml` only if the file it references contains the requested epic; otherwise use the matching `{bmad_dir}/implementation-artifacts/epics-and-stories-*.md` file that contains it (e.g. `epics-and-stories-dark-factory-v6.md` for DF/v6 epics, `epics-and-stories-v4.md` for P0/P1). This resolved file is called the **epic index** (`{EPIC_INDEX}`) below.

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

**Note:** Epic IDs and track tokens are case-insensitive (e.g., `DF4`/`df4`, `P1`/`p1`). You may use either uppercase or lowercase.

```bash
# Interactive mode (prompts for epic ID)
/skills:qds-sprint-planning

# Specify epic; track is detected from its prefix
/skills:qds-sprint-planning df4
/skills:qds-sprint-planning p1

# Specify epic and track explicitly (when the prefix is ambiguous)
/skills:qds-sprint-planning df4 df

# Resume interrupted workflow
/skills:qds-sprint-planning resume
```

## Enhancement Modes

### Default: `--standard`

When you run `/skills:qds-sprint-planning` without flags, you get `--standard` mode:

- **5 parallel research agents** with track-specific prompts
- **Wave-based writing strategy** based on dependency analysis
- **Full post-writing updates** (epic index, sprint-status.yaml)
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
3. **No epic provided**: Prompts for epic ID (e.g., "DF4", "P1")
4. **No track provided**: Uses the epic prefix (e.g. `DF`, `P1`, `SC`)
5. Validates epic exists in the epic index (`{EPIC_INDEX}`, resolved as in "Single-Track Constraint")
6. Prompts if the prefix is ambiguous

**HITL Interaction:**

```
🎯 QDS Sprint Story Planning

Epic ID: DF4
Track: DF
Status: Ready for Planning

Stories to plan: [DF4.1, DF4.2] (2 stories)
Quality Standard: Phase 2.5 atomicity gate (≤10 DoD items, ≤8 SP, ≤200 normative lines)

[p] Proceed with planning
[q] Quit
```

### Phase 1: Parallel Research (5 Tracks)

**5 Research Tracks (executed in parallel via Claude Code Task tool for concurrent agent execution):**

#### Backend Research Agents (default)

| Agent | Purpose | Research Focus |
|-------|---------|----------------|
| **Agent 1** | Story Pattern Analysis | Existing story files in the epic's `stories/` dir and sibling epics in `{EPIC_INDEX}` |
| **Agent 2** | Specifications | Spec paths named in the PRD / epic |
| **Agent 3** | Data & Contract Models | Schemas, types and storage named in the spec / epic, and the `src/` modules they live in |
| **Agent 4** | External Dependencies | Context7 MCP for libraries named in the epic and in `package.json` |
| **Agent 5** | Dependency Analysis | Story sequencing, wave/batch strategy from `{EPIC_INDEX}` and `sprint-status.yaml` |

#### Frontend Research Agents (epics targeting `visualizer/`)

| Agent | Purpose | Research Focus |
|-------|---------|----------------|
| **Agent 1** | Story Pattern Analysis | Existing story files in the epic's `stories/` dir and sibling epics in `{EPIC_INDEX}` |
| **Agent 2** | UX/UI Specifications | UX spec paths named in the PRD / epic |
| **Agent 3** | Component Research | Components already in `visualizer/src/` + the component library named in the epic |
| **Agent 4** | Frontend Patterns | Context7 MCP for libraries named in the epic and in `visualizer/package.json` |
| **Agent 5** | Dependency Analysis | Story sequencing, wave/batch strategy from `{EPIC_INDEX}` and `sprint-status.yaml` |

**Each research agent produces (write-to-file, return path):**

- **Writes** its structured report to
  `_bmad-output/workflow-state/qds-sprint-planning/{epic}-{track}/research/R{n}-{slug}.md`
  using the `Write` tool (e.g. `R1-story-template.md`, `R3-data-model.md`).
- **Returns to the orchestrator only**: the report file path + a ≤10-line
  abstract. The orchestrator passes that **path** into writer prompts —
  it does **not** inline full research bodies (that re-emits every report
  into every writer prompt; the dominant Phase-1→2 token sink). The
  orchestrator **interpolates each returned report path into the matching
  `{R1_PATH}`–`{R5_PATH}` placeholder** when constructing the Writer
  Agent prompts (see "Research Context (read these — paths, not inlined
  bodies)" in the Writing Agent Template), so each writer prompt carries
  five concrete file paths — not five report bodies.
- Writers `Read` the report paths they need. Reports stay specific to
  variant (backend vs frontend) and **incorporate learned patterns** from
  previous sessions (story estimation, wave strategy, research sources).

**Third-party claims come from source, not memory.** Any claim about a
pinned dependency's behavior — pi-lens, jev HTTP contract, Hindsight,
cgroup/kernfs, upstream caps/limits — must be verified against the
package's real source (`rg "<claim>" $(opensrc path <pkg>)`; see the
`opensrc` skill) and cited as `file:line`, never asserted from training
data.

**Conditional crosswalk agent (SPL-025 — MANDATORY when applicable).**
If this run consumes an upstream disposition/audit table that names
clauses as "surviving verbatim" (supersession audits, re-derivation
maps), one research agent MUST extract the ACTUAL VERBATIM TEXT of every
named clause from the source story files — real labels, real line
numbers — into a crosswalk report.

**Crosswalk output contract (SPL-025):** the crosswalk is `Write`n to
`_bmad-output/workflow-state/qds-sprint-planning/{epic}-{track}/research/crosswalk.md`
and its path returned to the orchestrator as **`{CROSSWALK_PATH}`**. This
work is owned by **Agent 1 (Story Pattern Research)** — when a crosswalk
applies, Agent 1 produces BOTH `{R1_PATH}` and `{CROSSWALK_PATH}`. The
orchestrator interpolates `{CROSSWALK_PATH}` into every writer prompt
alongside `{R1_PATH}`–`{R5_PATH}` (see "Research Context" in the Writing
Agent Template, which declares the conditional `{CROSSWALK_PATH}` input).
Writers consume ONLY the crosswalk, never the audit table directly. Clauses the audit names that do not
resolve to source text are marked **NET-NEW** in the crosswalk and
authored fresh under normal adversarial review — never pasted under a
"survives verbatim, do not re-litigate" banner (that launders unreviewed
requirements past the review loop). Audit tables cite clauses that often do
not exist or say something else in the source, so only extracted text is
trusted.

### Phase 2: Parallel Story Writing (Waves, Max 2 Stories Per Agent)

After research completes:

1. **Resolve the story folder** for the epic (see "Story Folder Resolution" below)
2. **Use its stories directory**: `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/`
3. **Determine wave strategy** based on Agent 5's dependency analysis
4. **Launch writing agents** with max 2 stories each (context quality degrades beyond that)
5. **Each writing agent produces TWO outputs:**
   - **Output 1 (Detailed)**: Full enterprise-grade story file → `{STORY_FOLDER}/stories/{story-slug}.md`
   - **Output 2 (Brief)**: Epic summary with link → for insertion into `{EPIC_INDEX}`

**Example wave pattern:**
- Wave 1: Stories DF5.1, DF5.2 (independent) → 1 agent
- Wave 2: Stories DF5.3, DF5.4 (depend on DF5.1) → 1 agent
- Wave 3: Story DF5.5 (standalone) → 1 agent

### Story Folder Resolution

Throughout this skill, `{STORY_FOLDER}` is a placeholder for the epic's folder under
`_bmad-output/sprint-artifacts/` — in QDS-Factory these are named per phase/program
(`phase-0`, `phase-1`, `phase-2`, `dark-factory-v5`, `dark-factory-v6`, …), not by sprint number.
Use the resolved folder name directly in every path below — never re-prefix it with `sprint-`
(a folder named `dark-factory-v6` writes to `sprint-artifacts/dark-factory-v6/stories/`,
not `sprint-artifacts/sprint-dark-factory-v6/stories/`).

Resolve it deterministically, in order:

1. **Existing stories dir**: find the `sprint-artifacts/*/stories/` directory that already holds story files for this epic (filename prefix, e.g. `df1-1-*.md` → `dark-factory-v5`; `p1-*.md` → `phase-1`). Match whole epic codes, not partial substrings.
2. **Epic index**: if none exist yet, use the folder that `{EPIC_INDEX}` and `sprint-status.yaml` name for the epic's program.
3. **Ask**: if still unresolved, ask the operator for the folder name rather than inventing one.

**Note:** If the epic identifier fails Phase 0 step 5 (epic not in the epic index), surface a validation error and ask the user to correct the epic rather than silently assigning a folder.

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

**Output:** `_bmad-output/sprint-artifacts/{STORY_FOLDER}/atomicity-audit-{YYYY-MM-DD}.md`

**HALT behavior:** If any BLOCK-severity finding lacks an operator
override entry in the report's "Override log" section, the workflow
halts before Phase 3. WARN findings are reported but non-blocking.

**Keyword-list contract:** The keyword list in check 8 must match
check 8 in `steps/phase-2-5-atomicity-audit.md` verbatim.

### Phase 3: Post-Writing Updates

After all stories complete:

**0. Adversarial Auto-Iteration (MANDATORY — runs BEFORE any commit/PR step below).**

Before any of the file-write / commit / PR steps in this phase, run the
adversarial-review iteration loop documented in
[`.claude/skills/qds-sprint-planning/steps/phase-3-wrap-up.md`](../../skills/qds-sprint-planning/steps/phase-3-wrap-up.md).

The loop (**delegated, structured**; the orchestrator never
holds story bodies or re-writes artifacts inline):

- Scans every Phase 2 story file + the epic definition for **domain
  triggers** (rls, migration, auth, secrets, upload, deserialization,
  file handling, …) and loads matching checklists from
  `.claude/skills/qds-sprint-planning/checklists/<domain>.md` as the
  `also_consider` payload.
- Spawns **one self-contained pipeline subagent per story** (or per
  2-story writer batch), **in parallel in one message**, passing
  **file paths + the checklist payload** — not story contents. Each
  subagent runs review→fix→verify in its **own context**, applying an
  adversarial review (assume the spec is wrong and hunt for gaps,
  contradictions and unstated assumptions) + the severity heuristics, and
  `Edit`s its story file **in place** each round.
- Categorizes findings into **HIGH** (structural), **MEDIUM**
  (clarity), **LOW** (nits). A subagent converges (and stops editing)
  when `HIGH == 0 AND MEDIUM <= 3` — typically 2–3 internal iterations.
- Each subagent returns a **structured verdict** (JSON: iterations,
  converged, final HIGH/MEDIUM/LOW counts, applied + surviving lists,
  checklists_fired) — **not prose, not the story body**. After the
  per-story agents return, one **cross-story consistency subagent**
  runs over the final file **paths** (+ sprint-status + epic block) and
  edits in place for any contradiction in shared patterns.
- The orchestrator aggregates verdicts **by data**. Fixes are already on
  disk (subagents edited in place) — **NOT a separate commit**; they are
  integrated into the same Phase 2 output that steps 1–8 below commit.
- If any verdict has surviving HIGH or > 3 MEDIUM (or a cross-story
  HIGH), the orchestrator surfaces a disposition table built from the
  verdict fields and **HALTs** the wrap-up until the operator chooses
  `[a]pply` / `[r]e-iterate` / `[e]dit` / `[q]uit`.

The adversarial-review log (counts per iteration, dispositions taken,
which domain checklists fired) is appended to the wrap-up commit's PR
body so reviewers see what was caught pre-CR.

> **Why this exists.** A single adversarial pass leaves structural
> issues that later surface as many PR review rounds; iterating until
> findings stabilize catches them before commit. See pattern SPL-024 in
> `.claude/learnings/qds-sprint-planning/patterns.yml`.

1. **Create individual story files** in `{STORY_FOLDER}/stories/` directory:
   - Each story file contains FULL enterprise-grade detail
   - File naming: `{story-slug}.md` (e.g., `df1-1-phase-abstraction-lifecycle.md`)
   - Use `Write` tool to create files at `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/{story-slug}.md`

2. **Update the epic index (`{EPIC_INDEX}`)** with BRIEF summaries:
   - Each story entry includes `**Story File:**` link to individual story file
   - Brief user story (As a **Role**, I want Feature, So that Value)
   - Bulleted AC summary (not full Given/When/Then)
   - Brief technical notes
   - Brief DOD checklist
   - Link to full detail: `**Full enterprise detail** is in the individual story file linked above.`

3. **Update `_bmad-output/sprint-artifacts/sprint-status.yaml`**:
   - Epic status → `ready-for-dev`
   - Story statuses → `ready-for-dev`

4. **Create feature branch**: `feature/epic-{EPIC}-stories`

5. **Commit**: `feat(epic-{EPIC}): write enterprise-grade stories`

6. **Push** to remote

7. **Create PR** to `dev` branch (PR body includes the adversarial-review iteration log from Step 0)

8. **Save session transcript** for reflection analysis (used by `/reflect` to extract learnings)

   **Transcript Storage:**
   - **Location**: `.claude/learnings/qds-sprint-planning/transcripts/`
   - **Filename format**: `YYYY-MM-DD_HHMMSS_<session-description>.md`
   - **How to save**: Manually copy the Claude Code session conversation into a new file in the transcripts directory
   - **Example**: `.claude/learnings/qds-sprint-planning/transcripts/2026-02-02_143000_DF4-planning-session.md`

   Quick command after planning completes:

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
You are analyzing existing story patterns for Epic {EPIC} from {EPIC_INDEX} and the
story files already in the epic's `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/` dir.

Extract the story template structure including:
- Story title format (### Story {EPIC}.X: [Title])
- User story format (As a **[Role]**, I want [Feature], So that [Value])
- Acceptance Criteria (Given/When/Then scenarios)
- Overview section format
- Technical Notes format
- 12-Factor Agent Compliance items
- Definition of Done categories and checklist items

Output: A complete story template that matches the established pattern for this track.

Return the template structure with placeholders like {STORY_ID}, {TITLE}, {POINTS}, etc.

**Conditional crosswalk task (SPL-025).** If this run consumes an upstream
disposition/audit table that names clauses as "surviving verbatim"
(supersession audits, re-derivation maps), also: read the source story files
those clauses cite, extract the ACTUAL VERBATIM TEXT of every named clause
with its real label and line number, and `Write` it to
`_bmad-output/workflow-state/qds-sprint-planning/{epic}-{track}/research/crosswalk.md`.
Clauses that do not resolve to source text are marked NET-NEW. When no such
audit table is in scope, skip this task entirely.

Return the template report's file path, and — only when the crosswalk task
applied — the crosswalk file path as well.
```

### Agent 2 - Specifications (Backend) / UX Specifications (Frontend)

**Backend:**

```
Research the specifications for Epic {EPIC}: the spec paths named in the PRD / epic
entry in {EPIC_INDEX}.

Extract:
- Interfaces, commands and tool contracts the epic touches
- Input/output schemas (TypeScript types / Zod schemas as the spec defines them)
- Any security or validation requirements

Output: Structured specification report with spec section references.
```

**Frontend:**

```
Research UX/UI specifications for Epic {EPIC}: the UX spec paths named in the PRD / epic.

Extract:
- Screen layouts and component requirements
- Design tokens (colors, typography, spacing)
- User flows and interactions
- Accessibility requirements

Output: Structured UX specification report with component mappings.
```

### Agent 3 - Data & Contract Models (Backend) / Components (Frontend)

**Backend:**

```
Research data and contract models for Epic {EPIC}.

Read:
- The schema / data-model spec paths named in the PRD / epic
- The `src/` modules that define those types, stores and migrations today

Extract:
- Relevant tables / stores and their schemas
- Types and their fields and relationships
- Multi-tenant or isolation patterns if applicable

**Important:** The code in `src/` is the source of record for what exists today;
the spec is the source for what the epic adds. Report where they disagree.

Output: Data and contract patterns report with file paths and schema details.
```

**Frontend:**

```
Research the components available for Epic {EPIC}.

Look at:
- Existing components under `visualizer/src/`
- The component library named in the epic (query its MCP server if one is configured)

Output: Component report with component names, props, and usage examples.
```

### Agent 4 - External Dependencies

```
Use Context7 MCP to find latest documentation for libraries needed for Epic {EPIC}.

Focus on: the libraries named in the epic and in `package.json` (or
`visualizer/package.json` for frontend epics), at the versions pinned there.

Output: External dependencies report with versions, API patterns, and code examples.
```

### Agent 5 - Dependency Analysis

```
Analyze dependencies between stories in Epic {EPIC} from {EPIC_INDEX} and
_bmad-output/sprint-artifacts/sprint-status.yaml.

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
You are writing enterprise-grade user stories for Epic {EPIC} (track {TRACK}).

## Stories to Write

You will write {STORY_COUNT} stories in this batch:
{STORY_LIST}

## Sprint Context

- **Story Folder**: {STORY_FOLDER} (the epic's folder under `sprint-artifacts/`, e.g. `dark-factory-v6`)
- **Story Directory**: `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/`
- **Story File Pattern**: `{story-slug}.md`

The `{story-slug}` is derived from the story ID and title:
- Format: `{epic-lower}-{num}-{title-kebab-case}.md`
- Example: Story `DF1.1` with title "Phase Abstraction Lifecycle" → `df1-1-phase-abstraction-lifecycle.md`
- Example: Story `P1.10` with title "Approve Resume Webhook" → `p1-10-approve-resume-webhook.md`

To generate: (1) lowercase the epic letter/number, (2) replace the dot with a dash, (3) append a dash, (4) convert the title to kebab-case.

## Research Context (read these — paths, not inlined bodies)

`Read` the research reports you need from the workflow-state `research/`
directory. The orchestrator gives you the paths + a one-line abstract per
report; pull the detail yourself rather than receiving it inlined (keeps
the orchestrator prompt small and your context scoped to what you write):

- **Story Template** (Agent 1): `{R1_PATH}`
- **Specifications / UX Specifications** (Agent 2): `{R2_PATH}`
- **Data/Component Patterns** (Agent 3): `{R3_PATH}`
- **External Dependencies** (Agent 4): `{R4_PATH}`
- **Dependency Analysis** (Agent 5): `{R5_PATH}`
- **Clause Crosswalk** (Agent 1; CONDITIONAL — present ONLY when this run
  consumes an upstream disposition/audit table naming "surviving verbatim"
  clauses): `{CROSSWALK_PATH}`. When present, this is the SOLE source for
  any clause the audit names "surviving verbatim" — read the crosswalk,
  not the audit table. Clauses the crosswalk marks NET-NEW are authored
  fresh under normal adversarial review.

## Quality Requirements

Every story MUST include:

1. **Header with spec reference**: `**Spec Reference:** [SPEC_FILE.md] §[SECTION]`
   — plus `**Story Points:**` and `**Sprint:**` header fields (SPL-028:
   mandatory header fields live HERE in the template, not in per-wave
   writer prompts — per-prompt statements replicate inconsistently
   across waves)
2. **User story format**: As a **[Role]**, I want [Feature], So that [Value]
3. **Overview section**: Technical overview with key patterns
4. **Acceptance Criteria**: Given/When/Then scenarios
5. **Technical Notes**: Model config, file structure, integration points
6. **12-Factor Agent Compliance** (backend) or UI Compliance (frontend)
7. **Definition of Done**: ≤10 HIGH-SIGNAL checkboxes spanning the 6
   category concerns (Implementation, Testing, Code Quality,
   Documentation, Dependencies, Integration — one line may cover a
   category; drop project-wide CI invariants like "tests pass"/"lint
   clean"). This is the Phase 2.5 atomicity gate's bar (check 4) — the
   single DoD standard for this skill.

**Size discipline (SPL-027):** target ≤185 normative lines per story.
The 200-line cap belongs to the Phase-3 adversarial loop, which needs
~15 lines of headroom to add invariants without cutting load-bearing
text — writers who aim at the cap converge at 195–200 and force review
fixes to be declined for line budget.

## Dual Output Pattern

Each story produces two outputs:

### Output 1: Individual Story File (Detailed)

Create a standalone file at `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/{story-slug}.md` containing:

- Full enterprise-grade story with all details
- Complete Acceptance Criteria with Given/When/Then scenarios
- Full Technical Notes section
- Complete API contracts / type schemas (backend) or component tables (frontend)
- Full 12-Factor Agent Compliance or UI Compliance section
- Definition of Done (≤10 high-signal items, per Phase 2.5 check 4)
- All subsections and details

### Output 2: Epic Summary (Brief)

For insertion into `{EPIC_INDEX}`, produce a brief summary:

```markdown
### Story {EPIC}.{NUM}: {Title}

**Story File:** [`sprint-artifacts/{STORY_FOLDER}/stories/{story-slug}.md`](./sprint-artifacts/{STORY_FOLDER}/stories/{story-slug}.md)

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
2. Then, provide the brief summary for epic-index insertion
3. After writing each story batch, pause for confirmation before continuing

Stay inside the Phase 2.5 atomicity gate (≤8 SP, ≤10 DoD items, ≤200 normative lines).
```

## Backend vs Frontend Story Differences

| Aspect | Backend (default) | Frontend (`visualizer/`) |
|--------|------------------|-------------------|
| **Spec References** | Spec paths named in the PRD / epic | UX spec paths named in the PRD / epic |
| **Story Sections** | Contracts table with TypeScript / Zod schemas | Component table |
| **Technical Notes** | Model config, file structure, security requirements | Screen layouts, user flows, accessibility |
| **Compliance** | 12-Factor Agent Compliance (III, VI, XI, etc.) | UI Compliance (responsive, a11y, i18n) |
| **DOD: Testing** | Unit, integration, security, performance tests | Component, E2E and accessibility tests |
| **DOD: Code Quality** | Story-specific only (CI runs `bunx tsc --noEmit` + biome) | Story-specific only (CI runs `vue-tsc` + lint) |
| **DOD: Integration** | Integration points named in the epic | Data/API bindings named in the epic |

## Post-Writing Updates Checklist

After all stories complete:

- [ ] **Adversarial review converged** (HIGH == 0, MEDIUM <= 3) per
      `steps/phase-3-wrap-up.md`. Iteration log captured for the PR body.
- [ ] **Domain checklists logged** (which `checklists/<domain>.md` files
      fired, which trigger words matched, which artifacts they were
      applied to).
- [ ] **Individual story files created** in `_bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/`
  - Each file contains FULL enterprise-grade detail
  - File naming follows `{story-slug}.md` pattern
  - Verify: `ls _bmad-output/sprint-artifacts/{STORY_FOLDER}/stories/`
- [ ] **Epic index (`{EPIC_INDEX}`) updated** with BRIEF summaries only
  - Each story has `**Story File:**` link to individual story file
  - AC summaries are bulleted, not full Given/When/Then
  - Technical notes are brief
  - Verify: `grep -c "Story File:" {EPIC_INDEX}` shows count >= story count
- [ ] **Epic header updated** with story count, points total, duration
- [ ] **sprint-status.yaml updated**:
  - Epic status → `ready-for-dev`
  - All story statuses → `ready-for-dev`
  - Points assigned to each story
- [ ] **Feature branch created**: `feature/epic-{EPIC}-stories`
- [ ] **Commit created**: `feat(epic-{EPIC}): write enterprise-grade stories`
- [ ] **Pushed to remote**
- [ ] **PR created** to `dev` branch with description linking to epic

## Verification Rules (Run After Planning)

After the skill completes, run these checks to verify the fix:

```bash
# Set to the epic index resolved in Phase 0 ({EPIC_INDEX}) — the epics-and-stories
# file that CONTAINS the epic just planned, not a hardcoded program
EPIC_INDEX=_bmad-output/implementation-artifacts/epics-and-stories-<program>.md

# Rule 1: Story files are in <epic-folder>/stories/ (not generic /stories)
# Check if any stories exist in top-level stories folder (should be empty)
if find _bmad-output/sprint-artifacts/stories -name "*.md" -print -quit 2>/dev/null | grep -q .; then
  echo "FAIL: Stories in generic /stories folder"
else
  echo "PASS: No story markdown files in _bmad-output/sprint-artifacts/stories"
fi

# Rule 2: Each story has a "Story File:" link in the epic index
LINK_COUNT=$(grep -c "Story File:" "$EPIC_INDEX" || echo "0")
echo "Found $LINK_COUNT story file links"
if [ "$LINK_COUNT" -lt 1 ]; then
  echo "FAIL: No story file links found"
else
  echo "PASS: Stories have file links"
fi

# Rule 3: the epic index is not bloated with full story detail
LINE_COUNT=$(wc -l < "$EPIC_INDEX")
echo "$EPIC_INDEX has $LINE_COUNT lines"
if [ "$LINE_COUNT" -gt 10000 ]; then
  echo "WARN: epic index is large: $LINE_COUNT lines"
else
  echo "PASS: epic index size reasonable"
fi
```

## Examples

### Example 1: Backend Epic

```bash
/skills:qds-sprint-planning df4
```

Output:

```
🎯 QDS Sprint Story Planning

Phase 0: Epic & Track Selection
  ✅ Epic: DF4
  ✅ Track: DF
  ✅ Epic index: _bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md
  ✅ Stories: 2 stories (10 estimated points)

Phase 1: Parallel Research (5 agents)
  ✅ Agent 1: Story patterns extracted from dark-factory-v5/stories/
  ✅ Agent 2: Specs named in the epic
  ✅ Agent 3: Data/contract models from the spec + src/
  ✅ Agent 4: External deps (libraries in package.json)
  ✅ Agent 5: Dependency analysis (1 wave recommended)

  Confidence Score: 0.92

Phase 2: Story Writing (Wave 1)
  ✅ Writing DF4.1 (5 pts)
  ✅ Writing DF4.2 (5 pts)

  [Detailed stories written to _bmad-output/sprint-artifacts/dark-factory-v5/stories/]
  [Brief summaries written to the epic index with Story File links]

Phase 3: Updates
  ✅ Epic index updated
  ✅ sprint-status.yaml updated
  ✅ Branch: feature/epic-df4-stories
  ✅ Commit: feat(epic-df4): write enterprise-grade stories

🎯 PR Created (base: dev): https://github.com/<org>/<repo>/pull/N
```

### Example 2: Frontend Epic (`visualizer/`)

For an epic whose stories target `visualizer/`, the frontend research variant runs:
Agent 2 reads the UX spec paths named in the epic, Agent 3 inventories
`visualizer/src/` components, Agent 4 queries Context7 for libraries in
`visualizer/package.json`. Phases 2–3 are identical; the PR targets `dev`.

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
- `qds-story-review` - Adversarial pre-dev review of the stories this skill writes

## Troubleshooting

### Research Agent Failures

If a research agent fails:

1. Check MCP server status (Context7)
2. Use `--verbose` to see detailed errors
3. Re-run with `/skills:qds-sprint-planning {epic} {track}` to retry

### Context Overflow

If context overflow occurs:

1. Reduce wave size (fewer stories per agent)
2. Use `--minimal` to skip spec validation
3. Plan epic in multiple runs (subset of stories each time)

### Component-Library MCP Unavailable

If the frontend epic's component-library MCP is not available:

1. Agent 3 falls back to the UX spec paths named in the epic and `visualizer/src/`
2. Component patterns inferred from existing frontend stories
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
- Claude Code Task tool (for parallel agent execution)

## Changelog

### [1.5.0] - 2026-10-03

**Project-fit cleanup for QDS-Factory (the skill was forked from an
RFP-Agents project and still carried its content).**

- **Changed:** tracks are the epic prefix (P0, P1, DF*, SC*, v6 Z/M/A/J/G),
  not "Track A/B"; backend vs frontend is now a research variant
  (frontend = epics targeting `visualizer/`).
- **Changed:** the epic index is resolved from `.qds-config.yml` /
  `sprint-status.yaml` `index:` / `implementation-artifacts/epics-and-stories-*.md`
  (`_bmad-output/epics.md` does not exist here).
- **Changed:** story folder is derived from the epic's existing
  `sprint-artifacts/*/stories/` dir; the RFP-Agents sprint-number table is gone.
- **Removed:** the A6 20-36-checkbox DoD standard and its quality table —
  the Phase 2.5 gate (≤10 DoD items) is the single DoD bar.
- **Removed:** RFP-Agents paths/stack (`services/api-gateway`, Alembic
  migration dirs, RFP spec files, Next.js/React/FastAPI/Pydantic/pgvector
  pins, RFP-Agents PR/issue links), the `/CLAUDE.md` status-line step,
  links to non-existent `bmad-*` skills, and the `sc:implement` reference.
- **Changed:** incident narratives in rule text replaced with one-clause
  reasons; version numbers dropped from banners; resources index lists
  `steps/phase-2-5-atomicity-audit.md`.

### [1.4.0] - 2026-08-12

**Reflect pass from the DF-v5 backlog derivation (31 stories / 111 pts,
PR #101). Transcript:
`.claude/learnings/qds-sprint-planning/transcripts/2026-08-12_063910_DF-v5-backlog-derivation.md`.**

- **Added (Phase 1, SPL-025):** mandatory conditional **crosswalk agent**
  whenever a run consumes an upstream disposition/audit table naming
  "surviving verbatim" clauses — verbatim source extraction with real
  labels/line numbers; unresolvable clauses marked NET-NEW and authored
  fresh under normal review. Caught 28 phantom clauses, a 10,000× unit
  contradiction, and an inverted security doctrine in DF-v5.
- **Changed (step 3.1a, SPL-026):** pipeline subagents now **Write their
  JSON verdict to `workflow-state/.../verdicts/<batch>.json`** in the
  original prompt, in addition to returning it — final-text-only verdicts
  are unreachable from the orchestrator after completion.
- **Changed (step 3.1b):** the cross-story agent receives the per-story
  verdicts' surviving **cross-boundary findings as an explicit work
  queue** (verifying attributions — one DF-v5 queue item blamed the wrong
  story), on top of its full-slate sweep.
- **Added (step 3.0.5 + Phase 2.5):** orchestrator **mechanical grep
  pre-scans** (atomicity mechanicals, shared-pattern tokens) before
  spawning judgment agents — cheap, catches gross failures instantly,
  grounds the shared_pattern_note in verified data.
- **Changed (Writing template, SPL-027/SPL-028):** writers target
  **≤185 normative lines** (cap headroom belongs to the review loop);
  `**Sprint:**` header mandatory **in the template** (per-wave prompt
  statements replicate inconsistently — 9 wave-1 omissions).
- **Fixed:** Quality Requirements item 7 contradicted the Phase 2.5
  atomicity gate (20-36 DOD checkboxes vs ≤10 high-signal) — gate wins,
  template now says so.

### [1.3.0] - 2026-06-19

**Token-efficiency rewrite of the adversarial wrap-up + research handoff
(delegate, don't re-emit).**

Motivated by instrumenting the QDS-MEM-003 run (13 stories): the
orchestrator emitted **~554k output tokens** in the main loop — almost
all of it re-writing story bodies in place across adversarial iterations,
and re-inlining research reports into every writer prompt. The subagents
found the problems; the orchestrator (Opus, main loop) did the expensive
writing. 37 agents spawned, 25 of them adversarial machinery routed
through the orchestrator.

- **Changed** (`steps/phase-3-wrap-up.md` Step 3.1): replaced the
  orchestrator-rewrites-in-place loop with a **per-story pipeline
  subagent** that owns review→fix→verify in its **own context** and
  `Edit`s the story file **in place**. One agent per story (or per
  2-story writer batch) + one cross-story consistency agent. Collapses
  the old review→fix→fix2→verify round-trips (≈25 agents) to ≈14.
- **Changed**: subagents return a **structured JSON verdict**
  (iterations / converged / final counts / applied + surviving /
  checklists_fired) — **not prose, not story bodies**. The orchestrator
  aggregates **by data** and never holds story text.
- **Changed**: the orchestrator passes **file paths + checklist
  payloads**, never file contents (levers 3 + 4).
- **Changed** (Phase 1→2 handoff): research agents now **Write** their
  reports to
  `workflow-state/qds-sprint-planning/{epic}-{track}/research/R{n}-*.md`
  and return only a path + ≤10-line abstract; writer agents `Read` the
  paths. Stops the orchestrator re-inlining every research body into
  every writer prompt.
- **Result (estimated)**: orchestrator output ~554k → ~180k; agents
  37 → ~22. ~2–3× cheaper per run with equal-or-better rigor (per-story
  pipeline verify is more coherent than fan-out-and-reassemble).
- **Scope note**: this release implements the four structural levers.
  Deferred trims (skip-converged re-review, adaptive research-track
  count, SKILL.md prompt-template extraction) tracked for a follow-up.

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
