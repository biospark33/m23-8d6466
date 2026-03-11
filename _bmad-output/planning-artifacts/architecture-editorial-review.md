# Editorial Review - Structure: Architecture Decision Document

## Document Summary
- **Purpose:** Define architectural constraints, decisions, and behavioral contracts for the QDS-Engineer-New platform, serving as the authoritative reference for all implementation work.
- **Audience:** Three distinct consumers: (1) dev agents picking up stories, (2) review agents validating implementations, (3) the scrum master writing stories and acceptance criteria.
- **Reader type:** LLM (primary consumers are AI agents, with human developer oversight)
- **Structure model:** Explanation (Conceptual) + Reference/Database hybrid. The document progresses from context through decisions to implementation patterns (conceptual scaffolding), but ADRs and pattern tables serve as random-access reference material.
- **Current length:** ~17,362 words across 72 headings (7 H2 sections, 52 H3 subsections, 13 H4 subsections). Contains 34 code blocks totaling ~3,621 words (21% of document). YAML frontmatter: ~468 words.

### Section Word Counts

| H2 Section | Words | % of Total |
|---|---|---|
| Frontmatter | 468 | 2.7% |
| Project Context Analysis | 2,410 | 13.9% |
| Starter Template Evaluation | 2,265 | 13.0% |
| Core Architectural Decisions | 7,583 | 43.7% |
| Step 4 Complete (ADR summary table) | 255 | 1.5% |
| Implementation Patterns & Consistency Rules | 1,090 | 6.3% |
| Project Structure & Boundaries | 1,714 | 9.9% |
| Architecture Validation Results | 1,522 | 8.8% |

---

## Recommendations

### 1. CONDENSE - Inline Code Blocks Throughout (Round 10 Finding Implementation)

**Rationale:** 34 code blocks consume 3,621 words (21% of the document). The Round 10 finding and Document Authority Principle already establish that this document should specify behavioral contracts, not implementation code. The Canonical Reference Locations table (Section 7) already points to where real implementations live. Most code blocks should be replaced with behavioral contract specifications referencing those canonical locations.

**Specific code blocks to condense:**

| Lines | Content | Action |
|---|---|---|
| 486-530 | `pipeline.db` full CREATE TABLE + indexes (181 words) | Replace with: 3 tables (`pipeline_runs`, `phase_transitions`, `gate_results`), key columns and constraints as bullet list, reference `shared-types/src/pipeline.ts` |
| 567-601 | `attribution.db` full CREATE TABLE + indexes (172 words) | Replace with: 2 tables (`attribution_chain`, `budgets`), key columns and constraint bullets, reference `shared-types/src/budget.ts` |
| 605-638 | `wrapApiCall()` attribution correlation pattern (113 words) | Replace with behavioral contract: "Pre-call: insert partial row with call_id. Post-call: merge usage + increment budget atomically. Budget exceeded: emit event + halt spawns, do not block current call." (~30 words) |
| 811-835 | Full `Bun.serve()` SSE handler (88 words) | **Note: ADR-011 G1 already supersedes this with Express.** Replace with behavioral description of the polling + streaming pattern. Reference `gateway/src/sse/poller.ts` and `gateway/src/sse/stream.ts` |
| 997-1021 | Express gateway server setup (114 words) | Replace with: "Express app mounts CopilotKit at `/api/copilotkit`, SSE at `/events`, WS via upgrade. Single port, single process." Reference `gateway/src/app.ts` |
| 1036-1047 | `useCopilotReadable` Tier 1 example (66 words) | Replace with contract: "Tier 1 summary: always-on, ~200 tokens, compressed string format with story/agent/cost/status counts." |
| 1051-1057 | `useCopilotReadable` Tier 2 example (24 words) | Merge with Tier 1 description as a single tiered-context specification |
| 1064-1077 | `useCopilotAction` Tier 3 example (58 words) | Replace with contract: "Tier 3: zero tokens until copilot invokes action. Large datasets pulled on demand, not pushed." |
| 1095-1117 | `renderAndWait` NudgeConfirmation example (89 words) | Replace with: "Destructive actions use CopilotKit renderAndWait for user confirmation before execution." |
| 1121-1132 | Wildcard render ActionIndicator (28 words) | Replace with: "All copilot tool calls render status indicators via CopilotKit wildcard render." |
| 1138-1155 | CopilotBridge component (91 words) | Replace with: "Headless CopilotBridge component registers all readables and actions. Mounts inside CopilotKit provider, returns null." Reference `dashboard/src/copilot/bridge.tsx` |
| 1193-1202 | `bunfig.toml` example (25 words) | Replace with description: "Per-package bunfig.toml with coverage, preload, and path ignore patterns." Reference `packages/*/bunfig.toml` |
| 1210-1228 | `vitest.config.ts` example (45 words) | Replace with description: "Vitest with happy-dom, React plugin, v8 coverage at 70/65/70 thresholds." Reference `dashboard/vitest.config.ts` |
| 1278-1296 | MockProvider class (62 words) | Replace with contract: "MockProvider implements Pi SDK Provider interface. Fixture responses keyed by `{agentRole}-{phase}`. Deterministic replay." Reference `tests/fixtures/mock-provider.ts` |
| 1300-1332 | CI pipeline YAML (96 words) | Replace with: "3-stage CI: Stage 1 (lint+typecheck+unit) gates PRs. Stage 2 (component+integration, matrix). Stage 3 (boundary+E2E, main only)." Reference `.github/workflows/ci.yml` |
| 1336-1349 | package.json scripts (65 words) | Replace with table of script names and descriptions. Reference root `package.json` |

**Code blocks to PRESERVE (one illustrative example per unique pattern):**

| Lines | Content | Rationale |
|---|---|---|
| 335-398 | Monorepo layout tree (580 words) | Essential structural reference. No canonical code equivalent. |
| 546-553 | `OverlayStage` interface (23 words) | Short, defines the cache-ready pattern. Keep as behavioral contract. |
| 697-705 | `PhaseScopedMailClient` (33 words) | Short, illustrates structural enforcement at application boundary. Keep. |
| 733-738 | `IsolationResult` type (29 words) | Short, defines the 3-state scoring model. Keep. |
| 857-872 | `DashboardCommand` + `ServerMessage` unions (122 words) | Defines the discriminated union contract. Keep as the Zod pattern example. |
| 939-966 | `GateContext` + `GateResult` + `Finding` (97 words) | Defines the gate script interface contract. Keep. |
| 1516-1534 | Zod schema pattern example (49 words) | One illustrative example of the Zod-as-source-of-truth pattern. Keep. |
| 1630-1793 | Complete project directory tree (1,032 words) | Essential structural reference. No code equivalent. |

**Impact:** ~1,050 words removed from code blocks replaced with behavioral contracts. Additional ~200 words saved from surrounding prose that explains code line-by-line. Net reduction: ~1,250 words.

---

### 2. CONDENSE - Cascading Implications Sections (5 instances)

**Rationale:** Five "Cascading Implications" sections total 807 words. These enumerate consequences that follow logically from ADR decisions (shared-types additions, factory.yaml schema additions, Overstory migrations). Much of this content is restated when the affected subsystem's ADR is later described or is visible in the project directory tree. The pattern creates a forward-reference problem: implications are listed before the reader has context for them, then repeated when context arrives. For LLM readers, this creates unnecessary token consumption. For the scrum master, implications are better discovered from the ADR itself when writing stories.

**Action:** Consolidate all cascading implications into a single reference table at the end of the Core Architectural Decisions section. Table columns: `ADR Source | Affected Package | Implication | Status`. Removes 5 repetitive prose sections, replaces with one scannable table. Items already reflected in the project tree or later ADRs (e.g., "shared-types additions" that appear in the Step 6 directory listing) should be cut entirely rather than moved to the table.

**Impact:** ~500 words (after deduplication with project tree and later ADRs).

---

### 3. CONDENSE - ADR-011 Copilot Section

**Rationale:** ADR-011 (lines 983-1166) is 1,166 words, making it the longest single ADR. Its 4 sub-decisions (G1-G4) include 8 code blocks totaling ~560 words. The Express server setup code (superseded note below), three tiers of `useCopilotReadable`/`useCopilotAction` examples, `renderAndWait` pattern, wildcard render, and the full CopilotBridge component are all implementation code that belongs in the codebase at the canonical locations already specified. The behavioral contracts for each tier can be expressed in ~3 sentences each.

**Impact:** ~450 words (code block reductions from Recommendation 1 account for most of this; the surrounding explanatory prose that walks through code line-by-line contributes ~100 additional words).

---

### 4. CONDENSE - ADR-009 Gateway SSE Code Example (Superseded)

**Rationale:** The `Bun.serve()` SSE handler code block at lines 811-835 (88 words) demonstrates a pattern that ADR-011 G1 explicitly supersedes with Express under Bun. The document already notes this amendment at lines 1165-1166 and in the Cascading Implications from Category 4. Keeping the original `Bun.serve()` code block creates confusion: a reader encountering the code in ADR-009 does not yet know it is superseded 350 lines later. This is the most concrete example of the "dual source of truth" problem identified in Round 10.

**Action:** Remove the `Bun.serve()` code block. Replace with a behavioral description of the SSE streaming contract (cursor-based polling, `async function*` pattern, keepalive interval, wire format). Add a forward reference note: "Server implementation updated by ADR-011 G1 to Express under Bun."

**Impact:** ~100 words saved, plus elimination of a known contradiction within the document.

---

### 5. MERGE - "Step 4 Complete" Summary Table with Validation Section

**Rationale:** The "Step 4 Complete" section (lines 1430-1450, 255 words) is an ADR summary table listing all 13 ADRs. The "Architecture Validation Results" section (lines 1884-2042) contains a "Coherence Validation" subsection that references the same 13 ADRs and an "Architecture Completeness Checklist" that again enumerates what was completed. Three separate locations summarize the same set of decisions. The Step 4 Complete section also uses workflow-internal language ("Step 4") that is meaningless to the document's three audiences.

**Action:** Move the ADR summary table into the Validation section under "Coherence Validation." Delete the "Step 4 Complete" H2 section. Remove the workflow-step heading.

**Impact:** ~150 words (prose around the table). More importantly, removes a section that breaks the reader's flow between ADR details and implementation patterns.

---

### 6. CONDENSE - Requirements Coverage Validation Table

**Rationale:** The "Requirements Coverage Validation" subsection (339 words) largely restates the "Requirements Overview" table from Section 1 (Project Context Analysis, 550 words) with an added "Architectural Support" column. An LLM reader or scrum master scanning for coverage information encounters the same 14 capability areas twice. The NFR coverage paragraph is also a restatement of the NFR summary from Section 1 with ADR cross-references added.

**Action:** Add an "Architectural Support" column to the original Requirements Overview table in Section 1. Reduce the Validation section's coverage subsection to a single confirmation statement: "All 119 FRs and 31 NFRs have architectural support. See Requirements Overview table for FR-to-ADR mapping." Cut the duplicated NFR paragraph.

**Impact:** ~250 words.

---

### 7. CONDENSE - Frontmatter (Party Mode Round Log)

**Rationale:** The YAML frontmatter contains 468 words, including a detailed log of all 10 Party Mode rounds with agent names, focus areas, and advanced elicitation methods. This metadata served the architecture workflow but has no value for the document's three audiences (dev agents, review agents, scrum master). The `partyModeRounds` and `advancedElicitation` arrays alone account for ~300 words. Each ADR already documents which Party Mode round produced it.

**Action:** Reduce frontmatter to: `status`, `completedAt`, `inputDocuments`, `sourceProjects`, `workflowType`, `project_name`, `date`. Remove `partyModeRounds`, `advancedElicitation`, and `stepsCompleted`/`lastStep` (workflow-internal state).

**Impact:** ~300 words.

---

### 8. CONDENSE - Step 4 Advanced Elicitation Log

**Rationale:** The "Step 4 Advanced Elicitation Log" subsection (152 words, lines 449-456) describes the elicitation methods used during Category 1 decisions. This is process documentation, not architectural content. The ADRs themselves contain the decisions and rationale. None of the three audiences need to know which of 10 elicitation methods produced a finding -- they need the finding itself.

**Action:** Delete this subsection. The relevant outcome ("StreamOptions.metadata is NOT echoed back") is already documented in ADR-005's rationale.

**Impact:** ~150 words.

---

### 9. CONDENSE - Source Project Codebase Findings Tables

**Rationale:** Three tables in "Source Project Codebase Findings" (618 words, lines 254-298) provide detailed codebase inspection results for ZeroClaw, Overstory, and Pi SDK. Many rows document findings that are already fully resolved and incorporated into ADRs (e.g., "All 5 SQLite databases use WAL mode" is resolved in ADR-003; "No discrete tier directives" is resolved in ADR-005). These tables served the architecture discovery process. For the document's audiences, the ADRs are the authoritative record.

**Action:** Keep only findings that are NOT fully resolved in an ADR or that provide context a dev agent needs when implementing (e.g., Overstory's overlay template-based system, which a dev agent must understand to wrap it). Cut rows where the ADR subsumes the finding. Estimate ~60% of rows are fully subsumed.

**Impact:** ~350 words.

---

### 10. QUESTION - Open Verification Items Status Table

**Rationale:** The "Open Verification Items Status" table (212 words, lines 432-446) lists 10 items, all marked RESOLVED. A fully-resolved checklist has zero ongoing value for any of the three audiences. The resolutions are embedded in the ADRs. However, this table serves as a traceability artifact showing that all unknowns identified during discovery were resolved before the document was finalized.

**Action:** Author decision. Options: (A) Delete entirely -- ADRs contain the resolutions. (B) Keep as a collapsed/appendix-style traceability record for audit purposes. If kept, move to the end of the document near the validation section.

**Impact:** ~212 words if deleted.

---

### 11. MOVE - Failure Mode Analysis Summary

**Rationale:** The "Failure Mode Analysis Summary" table (249 words, lines 417-431) appears in the Starter Template Evaluation section but covers failure modes spanning the entire architecture (Pi SDK attribution, Overstory coupling, budget circuit breakers). Its placement in the starter template section buries it. Dev agents implementing Factory Core, Gateway, or Pi SDK integration need to see these mitigations, but they will not scan the "Starter Template Evaluation" section for them.

**Action:** Move to the Architecture Validation Results section, where it logically belongs as a risk analysis artifact. Alternatively, distribute individual failure modes as "Risk" notes within their respective ADRs (e.g., the Pi SDK attribution failure mode belongs in ADR-005).

**Impact:** 0 words (reorder only). Improves discoverability for dev and review agents.

---

### 12. CONDENSE - Phase Boundary Test Suite File Listing

**Rationale:** The "Phase Boundary Test Suite" subsection (lines 766-783, 114 words) lists a proposed 33-file, ~198-test directory structure. ADR-012 T4 (lines 1245-1259) repeats the same directory structure in condensed form. The first occurrence includes test counts per directory that are planning estimates, not architectural constraints.

**Action:** Remove the first occurrence (in ADR-006/007 area). Keep the condensed version in ADR-012. Add test count estimates as inline notes in ADR-012 if desired.

**Impact:** ~114 words.

---

### 13. CONDENSE - Duplicate Directory Tree Listings

**Rationale:** The "Monorepo Layout" tree (lines 335-398, 580 words) and the "Complete Project Directory Structure" tree (lines 1630-1793, 1,032 words) both describe the project structure. The second is a strict superset of the first, adding Round 9's structural refinements (gate script placement, copilot directories, store slices, etc.). Two directory trees 1,300 lines apart create a maintenance burden and a staleness risk.

**Action:** Remove the first "Monorepo Layout" tree. Add a forward reference: "See Complete Project Directory Structure in the Project Structure & Boundaries section for the full layout." The second tree is the canonical structural reference.

**Impact:** ~580 words. The forward reference costs ~20 words.

---

### 14. PRESERVE - Cross-Cutting Concerns Section

**Rationale:** The "Cross-Cutting Concerns Identified" section (480 words) might appear redundant with the ADRs that resolve each concern. However, this section serves a critical scaffolding function: it establishes the architectural forcing functions that explain *why* the ADRs exist. A dev agent encountering ADR-006 (Phase Boundary Protocol) benefits from understanding that context isolation is the #1 structural forcing function. A scrum master writing stories benefits from the priority ranking. Cutting this section would remove the "abstract before concrete" scaffolding that the Explanation structure model requires.

**Impact:** 0 words (explicit keep). Cost: 480 words retained.

**Comprehension note:** Removing this section would significantly impair the ability of agents and scrum master to understand architectural priorities and the relationships between decisions.

---

### 15. PRESERVE - State Ownership Model Table

**Rationale:** The "State Ownership Model (Draft)" table (261 words) provides a unique cross-cutting view of data ownership, storage locations, sharing models, and consistency guarantees. This information is scattered across ADR-003, ADR-005, ADR-009, and ADR-011. No single ADR provides this consolidated view. Dev agents implementing cross-subsystem features need exactly this "who owns what" reference. The "(Draft)" label should be updated to reflect that ADRs have since resolved the state boundaries.

**Impact:** 0 words (explicit keep). Action: Remove "(Draft)" from the heading since ADRs have finalized state boundaries.

---

### 16. PRESERVE - Enforcement Mechanism Mapping Table

**Rationale:** The Enforcement Mechanism Mapping table (154 words) is the single most valuable table for review agents. It maps every pattern category to its enforcement mechanism, enabling review agents to verify that implementations use the correct enforcement path. This is the "how do I check this?" reference. Removing it would force review agents to scan the entire document for enforcement details.

**Impact:** 0 words (explicit keep).

---

### 17. PRESERVE - Canonical Reference Locations Table

**Rationale:** The Canonical Reference Locations table (220 words) is the foundation of the Document Authority Principle established in Round 10. It is the bridge between architectural contracts and implementation code. All three audiences use it: dev agents find where to implement, review agents find where to validate, scrum master finds where to point acceptance criteria.

**Impact:** 0 words (explicit keep).

---

### 18. QUESTION - Updated Technology Versions Table

**Rationale:** The "Updated Technology Versions" table (123 words) pins specific version numbers for 11 dependencies. These versions will become stale. The Document Authority Principle suggests that dependency versions belong in `package.json` files, not in the architecture document. However, the architecture document is the only place where version compatibility is explicitly validated across the stack (e.g., confirming CopilotKit 1.52.1 works under Bun, confirming Vite 7 compatibility).

**Action:** Author decision. Options: (A) Keep the table but add a note: "Canonical versions in package.json. This table records architectural compatibility validation at decision time." (B) Move to an appendix. (C) Delete and rely on package.json.

**Impact:** ~123 words if deleted.

---

## Summary

- **Total recommendations:** 18 (9 CONDENSE, 2 MERGE, 1 MOVE, 2 QUESTION, 4 PRESERVE)
- **Estimated reduction if all CONDENSE/MERGE/MOVE accepted:** ~3,700 words (~21% of original 17,362)
- **Estimated reduction if QUESTION items also accepted:** ~4,035 words (~23% of original)
- **Meets length target:** No explicit length target specified. The 21-23% reduction addresses the Round 10 concern about code block staleness while preserving all architectural decisions and behavioral contracts intact.
- **Comprehension trade-offs:** The PRESERVE recommendations protect 4 elements (1,135 words) that serve critical reference functions for all three audiences. The largest single reduction (Recommendation 13, duplicate directory tree, 580 words) has zero comprehension cost since the complete version is retained. The code block condensation (Recommendation 1, ~1,250 words) replaces implementation code with behavioral contracts, which is an improvement for LLM readers who need constraint specifications, not code to copy.

### Priority Ordering for Implementation

**High priority (address the Round 10 finding directly):**
1. Recommendation 1 - Code block condensation (behavioral contracts over code)
4. Recommendation 4 - Superseded SSE code removal
13. Recommendation 13 - Duplicate directory tree

**Medium priority (reduce redundancy and improve flow):**
2. Recommendation 2 - Cascading implications consolidation
5. Recommendation 5 - Step 4 Complete merge
6. Recommendation 6 - Requirements coverage deduplication
12. Recommendation 12 - Duplicate phase boundary test listing
9. Recommendation 9 - Source project findings condensation

**Low priority (process artifact cleanup):**
7. Recommendation 7 - Frontmatter reduction
8. Recommendation 8 - Elicitation log removal
11. Recommendation 11 - Failure mode analysis relocation

**Author decisions needed:**
10. Recommendation 10 - Open verification items (delete or move?)
18. Recommendation 18 - Technology versions table (keep, move, or delete?)
