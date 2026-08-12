# R1 — Canonical DF Story Template & Authoring Constraints

**Research agent:** R1 (Story Template Analysis)
**Date:** 2026-08-11
**Consumers:** Phase 2 writing agents for Dark Factory v5 (`DF*` stories)

**Sources analyzed**

| Source | Path |
|--------|------|
| Exemplar (max rigor) | `_bmad-output/sprint-artifacts/phase-1/stories/p1-6-pi-team-protocol-step.md` (141 lines) |
| Exemplar (max discipline) | `_bmad-output/sprint-artifacts/phase-1/stories/p1-13-cost-ledger-budget.md` (71 lines) |
| Exemplar (E2E/lights-on) | `_bmad-output/sprint-artifacts/phase-1/stories/p1-15-real-pr-produced.md` (79 lines) |
| Atomicity gate (authoritative) | `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md` |
| Project rules | `.claude/learnings/qds-sprint-planning/patterns.yml` (SPL-006/007/008/014/015/016) |
| Skill body | `.claude/commands/skills/qds-sprint-planning.md` §Writing Agent Template, §Phase 2.5 |
| BMAD base template | `~/.claude/skills/bmad-create-story/template.md` (generic; NOT the QDS shape — see §7) |
| Spec being derived from | `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` |

---

## 1. Hard constraints (the Phase 2.5 gate)

Every DF story file is audited before Phase 3. **BLOCK halts the workflow; WARN is
advisory but should still be cleared.** All eight checks below are verbatim from
`phase-2-5-atomicity-audit.md` §"Validation checks".

| # | Check | Limit | Severity | Notes |
|---|-------|-------|----------|-------|
| 1 | Normative content size | ≤ 200 lines | **BLOCK >250**, WARN 201–250 | Excludes appendices and the `## Dev Agent Record` block. ≤200 passes silently. Remedy on violation: run `bmad-distillator`. |
| 2 | Total file size | ≤ 400 lines | WARN | Remedy: extract rationale / worked examples / cross-refs to `<sprint>/CONTEXT.md` and link. |
| 3 | SP budget | ≤ 8 SP | **BLOCK** | Remedy: "split into N+M sub-stories" using the Core/Tools cut (SPL-007). |
| 4 | DOD checkbox count | ≤ 10 high-signal items | WARN | Explicitly remove project-wide CI invariants: `ruff clean`, `tests pass`, `mypy clean`, `lint clean`, `format check`. Those are CI guarantees, not story DOD. |
| 5 | Title `AND` connectors | ≤ 1 `and` / `&` / `+` (case-insensitive) | WARN | ≥2 conjunctions ⇒ flag for split review. |
| 6 | Blocker markers | 0 instances of `⛔`, `pending sign-off`, `TBD on` | **BLOCK** | Requires ADR resolution or an explicit dependency-story link before the story leaves Phase 2.5. |
| 7 | `## Files to Modify` section | MUST exist; ≤ 10 unique paths | **BLOCK if absent**, WARN if >10 | Section header must be exactly `## Files to Modify`. |
| 8 | `## Security Invariants` section | Required when any keyword class (below) matches | **BLOCK if triggered + absent** | `N/A` is NOT a valid answer. A body that is empty, `N/A`, or pure rationale-without-invariants does NOT clear the BLOCK. |

### 1.1 Project rule that is stricter than the gate

**SPL-006 (confidence: high, user-mandated):** target **3–5 SP**; **split trigger is
`story_points >= 6`**, not 8. The gate BLOCKs at >8, but the project rule requires a
split at ≥6. Write to 3–5 SP. Split patterns:

- 6–8 pts → A + B (~4 each) · 9–12 pts → A + B + C · >12 → more
- Agent-shaped stories use the Core/Tools cut (SPL-007): `A` = core class /
  orchestration / phase wiring; `B` = individual tools + schemas + registration.
- Sub-story IDs take a letter suffix (SPL-008): `DF1.6` → `DF1.6A`, `DF1.6B`;
  slugs `df1-6a-<title>.md`, `df1-6b-<title>.md`.

**Addendum (2026-08-12, post-derivation):** the DF v5 pre-dev adversarial review
re-pointed six stories above the 5 SP target without splitting them — DF1.6
5→8, DF2.1 3→4, DF2.9 3→5, DF3.4 4→6, DF4.1 4→6, DF6.1 4→6 — as a recorded,
approved exception ("fewest files," `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
DD-13). This addendum does not amend the SPL-006 rule for future derivations;
it records that this specific slate's overage is a deliberate, already-ratified
deviation, not an open gap.

### 1.2 Security keyword classes (check 8 trigger)

Triggers on ANY match, case-insensitive, in the story body, AC, acceptance-test text,
**or Files-to-Modify paths**. This list is a cross-skill contract. **Accuracy note (verified
2026-08-12):** the keyword list does NOT currently live in the BMAD base template
(`~/.claude/skills/bmad-create-story/template.md` — the generic BMAD skeleton; no `## Security
Invariants` section, no keyword list; 0 matches on grep) nor in `bmad-check-implementation-readiness`
(also 0 keyword-list matches). The only live copies are this skill's check 8 and the QDS story
template / atomicity audit. Drift between those live copies is a bug; treating the BMAD base template
as a canonical source of the list (as `phase-2-5-atomicity-audit.md` "Cross-skill contract" and SPL-016
do) is the broken assumption — see §7.

- RLS / row-level security / policy
- migration / DDL / schema change / alembic
- auth / authentication / authorization / RBAC / capability / scope / permission
- encryption / secrets / KMS / vault / credential
- PII / personal data / GDPR / HIPAA
- payment / billing / financial / PCI
- tenant / multi-tenancy / cross-tenant
- upload / file handling / deserialization / parse

**Practical consequence for DF v5:** essentially every DF story trips this list —
the architecture is built on per-run capped credentials, sandbox isolation, path
traversal defenses, and a cost ledger. Treat `## Security Invariants` as **mandatory
on every DF story** and do not spend audit cycles deciding whether it triggered.

---

## 2. Resolving the rigor-vs-cap tension

**The tension is real but smaller than it looks.** Measured against the gate:

| Exemplar | Total lines | DOD items | Files listed | Verdict |
|----------|-------------|-----------|--------------|---------|
| P1.13 | 71 | 9 | 8 | **Passes every check.** This is the shape to copy. |
| P1.15 | 79 | 11 | 6 | WARN on DOD count only (by 1). |
| P1.6 | 141 | 18 | 5 | WARN on DOD count (18 vs 10). Passes the line cap *by line count* — but its lines run 400–900 characters each. It is over budget in substance, not in the metric. |

P1.6 is not naturally long; it *became* long. Eight rounds of adversarial review
appended reconciliation prose inline — "RECONCILED 2026-07-27", "the prior note was
stale and has been removed", three restatements of the same precedence rule in
Technical Notes, the mapping table, and INV-3. **The rigor is worth keeping; the
audit-trail-as-prose is not.**

### Six rules that keep P1.6-grade rigor inside a 200-line budget

1. **Cite, never restate.** A contract defined in the v5 design doc gets one line:
   `Step output schema: per v5 §5.2 (exitStatus enum CC-1, changedFiles, testResults,
   durationMs, mulchPrimed/mulchPrimeError, artifacts).` Do not paste the schema
   unless this story *changes* it.
2. **State each rule once, in its owning section.** Precedence rules live in
   Technical Notes. Invariants live in Security Invariants. A DOD item *references*
   the rule ("enforces the precedence rule in Technical Notes"); it does not re-derive it.
3. **No reconciliation prose in the story.** Decisions belong in the decision register
   (v5 §4, `D1`–`D10`) and the findings record (v5 §10, `F1`–`F16`). Cite `D5` / `F13`;
   never narrate the debate. If a decision changed after the story was written, edit
   the story to the new truth and let git carry the history.
4. **Tables over paragraphs** for enumerations (exit codes, triggers, infra,
   field mappings). A 6-row table beats a 200-word paragraph and is auditable.
5. **One make-or-break AC + 3–4 supporting.** More than 5 AC is a sizing signal, not
   a thoroughness signal.
6. **Overflow goes to `CONTEXT.md`.** Worked examples, rationale, and long JSON
   samples move to `_bmad-output/sprint-artifacts/<sprint>/CONTEXT.md` with a link
   from the story (this is the audit's own remedy for check 2).

### Suggested line budget (200 normative lines)

| Section | Lines |
|---------|-------|
| Title + Story Points + Spec Reference + User Story | 12 |
| Overview | 6 |
| E2E Slice (behavior + wiring-closed + deps) | 10 |
| Acceptance Criteria | 20 |
| Trigger Surface | 10 |
| Infra Prerequisites | 10 |
| Technical Notes | 40 |
| Observability Contract | 6 |
| Files to Modify | 8 |
| Security Invariants | 15 |
| Definition of Done | 12 |
| **Subtotal** | **149** |
| Headroom for story-specific depth | ~50 |

---

## 3. The canonical DF story template

Copy verbatim; replace `{PLACEHOLDERS}`; delete guidance comments before writing.
Section order is load-bearing — the audit and downstream readers expect it.

````markdown
# {STORY_ID}: {TITLE}

**Story Points:** {POINTS}

## Spec Reference

- {SPEC_FILE} §{SECTION}, §{SECTION}
- Decision register: {D_IDS}                  <!-- e.g. v5 §4 D5, D7 -->
- Contracts: {SPEC_FILE} §5.2 {CONTRACT_NAMES}
- Phase exit gate: {SPEC_FILE} §{SECTION} clause {N}   <!-- omit if none -->

## User Story

As a {ROLE},
I want {CAPABILITY},
so that {VALUE}.

## Overview

{One paragraph, 3-6 sentences. Trace the flow through named components in order:
A -> B -> C -> observable result. Name the wiring this story closes. No rationale,
no alternatives-considered, no history.}

## E2E Slice

**Demonstrable behavior:** Given {PRECONDITION}, When {TRIGGER}, it {STEP} -> {STEP}
-> {OBSERVABLE ARTIFACT with concrete values}.

**Wiring closed:** On completion of this story, {BEHAVIOR} is real using only code
merged by this story. No stub, no `TODO: wire later`, and no sibling story is
required to make this behavior real.

**Dependency edges (predecessors):** {STORY_IDS}.

## Acceptance Criteria

1. **(make-or-break)** Given {CONTEXT}, When {ACTION}, Then {OUTCOME with the exact
   contract shape or a §-reference to it}.
2. Given {CONTEXT}, When {ACTION}, Then {OUTCOME}.
3. Given {FAILURE CONTEXT}, When {ACTION}, Then {DEGRADED OUTCOME} and {the system
   does not crash / hang / retry indefinitely}.
4. Given {EMPTY-OR-BOUNDARY CONTEXT}, When {ACTION}, Then {explicit non-error
   behavior}.

<!-- 4-5 AC. AC1 is always the make-or-break. Always include one failure-path AC
     and one boundary/empty-state AC. -->

## Trigger Surface

<!-- SPL-014 — MANDATORY. Enumerate EVERY entry point that can invoke this story's
     pipeline. Each row is in-scope with a named E2E test, or out-of-scope with a
     follow-up story ID. "Out of scope and undocumented" = guaranteed regression.
     Candidate surfaces: HTTP routes, UI handlers, chat/agent tools, scheduled jobs,
     webhook receivers, MCP server tools, internal pub/sub handlers, CLI commands. -->

| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| {POST /api/...} | in-scope | `{tests/...}` | — |
| {`fleet dispatch` CLI} | in-scope | `{tests/...}` | — |
| {scheduled `{job}`} | out-of-scope | — | {DF{E}.{N}} |

## Infra Prerequisites

<!-- SPL-015 — MANDATORY. Every deployed component this story depends on, the
     service that provides it in the target environment, and the lifecycle hook
     that initializes its dependencies. Code-on-disk is NOT deployment. Each row's
     "Lifecycle Hook Verified" cell must be populated before ready-for-dev. -->

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| {sandbox provider} | {exe.dev driver / OCI image} | {setup gate returns ready} |
| {trace store} | {`trace-db` in the box image} | {schema migrated on box init} |

## Technical Notes

- **Contracts/Schema:** {Cite §5.2 for surviving contracts. Inline ONLY the fields
  this story adds or changes.}
- **Integration points:** {Named components in call order.}
- **Guards/limits:** {Numeric bounds with units: timeouts, caps, retry counts,
  size ceilings. State whether a ceiling INCLUDES its truncation suffix.}
- **{Story-specific rule}:** {Precedence rules, mapping tables, enum taxonomies.
  State once here; reference from AC/DOD rather than restating.}
- **Deviation/assumption:** {Any assumption about an external system's behavior,
  plus what happens if it is wrong. Cite the finding ID if the v5 review recorded it.}

## Observability Contract

- Every {unit of work} logs: `{ requestId, phase, agentId, timestamp, duration, exitStatus }`
- requestId propagates from {SOURCE}; errors include `{ code, message, stack? }`
- Sub-timings: `{name_ms}`, `{name_ms}`. {Fallback when the runtime does not expose a
  breakdown: report 0 and treat `durationMs` as authoritative.}

## Files to Modify

<!-- MANDATORY (BLOCK if absent). <=10 unique paths. Include the test files. -->

- `{src/path/file.ts}`
- `{tests/path/file.test.ts}`

## Security Invariants

<!-- MANDATORY whenever any security keyword class is triggered; on DF v5 that is
     effectively always. Concrete named invariants only. "N/A" does NOT clear the gate. -->

- INV-1: {Isolation / scoping invariant — what boundary exists and what enforces it.}
- INV-2: {Input-validation invariant — the check, the ordering, and the failure mode.}
- INV-3: {Resource-limit invariant — the cap, the detection mechanism, the kill path.}
- INV-4: {Credential/secret invariant — where it lives, what it can spend, how it is revoked.}
- INV-5: {Fail-closed clause — what the system does when the control is unavailable
  on the running platform. Never silently degrade.}

## Definition of Done

<!-- <=10 high-signal items. NEVER include project-wide CI invariants
     (ruff clean / tests pass / mypy clean / lint clean / format check).
     Each item must be falsifiable by inspecting this story's diff. -->

- [ ] **Impl:** {behavior}
- [ ] **Impl:** {behavior}
- [ ] **Contract:** {schema enforced, named}
- [ ] **Integration:** {named seam wired}
- [ ] **Security:** {invariant enforced, referencing INV-N}
- [ ] **Test (unit):** {specific assertion}
- [ ] **Test ({named edge case}):** {input -> expected classification/rejection}
- [ ] **Test (e2e demo — MANDATORY):** {trigger -> observable artifact}

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
````

---

## 4. Conventions observed in the exemplars

### 4.1 Spec citation

Format is `{FILE} §{SECTION}` plus flat requirement IDs, as a bullet list under
`## Spec Reference`. Multiple sections are comma-joined on one line.

- P1.6: `PRD §8, §10; FR-OR-3, FR-EX-6` then `Phase exit gate: PRD §13 Phase 1 clause 6`
- P1.13: `PRD §5.3, §6.1; FR-CP-4, FR-CP-12, NFR-COST-1, NFR-COST-2, NFR-ACC-3`
- Inline citations inside prose use the same form, e.g. "(NFR-ACC-3: derived on
  demand, never stale)" — the requirement ID plus a compressed restatement of it.

**For DF v5** the spec surface is `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md`.
Its citable anchors are: `§1` exec summary, `§3.1`–`§3.8` findings per system,
**`§4` decision register `D1`–`D10`**, `§5.1` tiers, **`§5.2` contracts**, `§5.3` data
flow, `§5.4` memory, `§6` security architecture, `§7` asset disposition, `§8` build
order, `§9` risks `R1`–`R11`, **`§10` adversarial findings `F1`–`F16`**. Cite the
decision ID when a story exists *because* of a decision (e.g. "team runtime is pi via
`team-lead-driver.ts` per D5"), and cite the finding ID when a story exists to close
a review gap (e.g. "host-side re-verification per F10").

### 4.2 Invariant naming — `INV-N`

- Default: bare sequence `INV-1 … INV-N`, scoped to the story (P1.6, P1.15).
- Domain-suffixed when the invariants are a coherent named family:
  `INV-COST-1 … INV-COST-4` (P1.13). Use this when the invariants will be
  referenced from sibling stories.
- One invariant = one enforceable property, stated as an assertion about the running
  system, not as a task. Compare: "INV-1: webhook endpoint validates GitHub signature
  (HMAC-SHA256) before processing — rejects unauthenticated payloads."
- Sub-clauses that qualify an invariant get a bolded lead-in inside the same bullet
  (P1.6 INV-1's "**Canonical root (P1.6-R6-1) — there is exactly ONE.**"). Keep these
  rare; they are the main reason P1.6 bloated.
- Invariants are referenced from DOD items by ID: `**Security:** … (see INV-2)`.

### 4.3 Cross-cutting contract naming — `CC-N`

`CC-N` marks a contract shared across sibling stories in the same phase — a single
numbering space owned by the phase, not by any one story. Observed in P1.6: CC-1
(exitStatus taxonomy), CC-2/CC-13 (Warren CLI surface), CC-3 (PI extension mapping),
CC-4 (field-name alignment `changedFiles`), CC-7 (`mulchBankId`→`mulchBank`
translation + timeout alignment), CC-9 (observability contract), CC-14
(`.canopy/agent.json` ownership).

Usage rules:
- Cite as a parenthetical on the sentence that states the contract:
  "Field name `changedFiles` matches P0.3 canonical output (CC-4)."
- The story that *owns* the contract states it fully; every other story cites the ID
  and the owning story. Never two full statements of the same CC.
- A superseded CC keeps its number and names its successor (CC-2 → CC-13 amended).

**For DF v5:** the surviving contracts are enumerated in v5 §5.2 (team runtime
interface / NDJSON `parseTeamEventLine`; step output schema; security invariants;
observability). Establish the DF-phase CC space from §5.2 rather than inventing a
parallel numbering.

### 4.4 Story-local finding IDs — `{STORY}-{ROUND}-{N}`

P1.6 carries `P1.6-R5-1`, `P1.6-R6-2`, `P1.6-R2-5`, `P1.6-N2/N3/N4` — adversarial-review
round provenance embedded in the text. **Do not author these into new DF stories.**
They accumulate during review; a freshly written story starts clean. (Their presence
in P1.6 is exactly the audit-trail-as-prose that pushed it to 141 dense lines.)

### 4.5 `exitStatus` enum

Canonical 5-value enum (CC-1, restated in v5 §5.1):

`"success" | "transient" | "overflow" | "logic" | "lead_failure"`

- `success` — normal completion **and** the merged-JSON envelope was emitted.
- `transient` — retryable (network, timeout, rate limit, unknown-origin signal).
- `overflow` — resource limit exceeded (budget, turn cap, RSS watchdog kill).
- `logic` — task logic error (test/assertion failure, user-initiated cancel).
- `lead_failure` — harness-classified: the lead exited **under its own control**
  before emitting the envelope. `exitCode` reflects the lead process exit.

Precedence (P1.6, and the correct pattern to reuse): **how the process died outranks
whether it emitted an envelope, which outranks its exit code.** A harness-initiated
kill is classified by kill origin (`overflow` / `logic`), never `lead_failure`.

`'logic_error'` is a known typo for `'logic'`; treat any occurrence as `'logic'`.

**Live-fire caveat for DF stories (v5 §3.1 row 5, F3):** warren v0.14.1 publishes a
real exit-code table — `0` success, `1` run-failed, `2` usage-error, `3`
server-unreachable, `4` auth-rejected, `130` sigint-detach — which **contradicts**
P1.6's assumed 0/1/2/3 → success/logic/transient/overflow mapping. Any DF story that
maps a runtime's exit codes must derive the mapping from that runtime's published
table and cite it; do not copy P1.6's table.

### 4.6 Declaring dependencies

Three distinct mechanisms; keep them distinct:

1. **`**Dependency edges (predecessors):** {IDS}.`** — one line in `## E2E Slice`. A
   flat comma-separated list of story IDs. This is the machine-readable edge set.
2. **Wiring-closed clause** — the boilerplate sentence asserting predecessors are
   *edges*, not unfinished wiring inside this story. Reuse near-verbatim.
3. **Predecessor reconciliation blockquote** — a `>` block used only when a
   predecessor's status changed (killed / deferred / restored) and the edge list
   would otherwise mislead. P1.6 and P1.15 both carry one. **Prefer citing the v5
   asset-disposition table (§7) over writing a new reconciliation blockquote** — the
   disposition of every Phase-0/1 asset is already recorded there.

### 4.7 Evidence & verification specification

- **DOD test items name the input and the expected classification**, not the activity.
  Good: "Lead process exits with code `0` **on its own** (no harness kill) having
  emitted NO merged-JSON envelope → verify `exitStatus: "lead_failure"` with
  `exitCode: 0`, NOT `"success"`."
- **Negative-control assertions.** The strongest DOD items state which *wrong*
  implementation must fail the test: "a bare-`O_NOFOLLOW` implementation passes this
  path and MUST fail the test." Carry this pattern forward — it converts a test from
  a checkbox into a discriminator.
- **`Test (e2e demo — MANDATORY)`** is the last DOD item on all three exemplars.
  Keep it, keep the literal `— MANDATORY` marker, and make it name the observable
  artifact (a PR on GitHub, a captured JSON step output, a halted run with
  `status: 'over-budget'`).
- **Pre-dev verification tasks** for assumptions about external systems go in
  Technical Notes with an explicit downgrade path (P1.6's "if live-server
  verification is not feasible, downgrade AC1's verification path to
  integration-tested with a PATH-shim … and record the verification gap in the Dev
  Agent Record"). Note: a pre-dev task must **not** be phrased with `TBD on` or
  `pending sign-off` — those strings BLOCK at check 6.
- **DOD category prefixes**, bolded, in this order:
  `**Impl:**`, `**Contract:**`, `**Integration:**`, `**Security:**`,
  `**Test (unit):**`, `**Test ({named case}):**`, `**Test (e2e demo — MANDATORY):**`.

---

## 5. Story slug convention

**Format:** `df{epic}-{num}-{kebab-title}.md`

Derivation (from the skill's Writing Agent Template, §"Sprint Context"): lowercase the
epic code, replace the dot with a dash, append a dash, kebab-case the title.

| Story ID | Slug |
|----------|------|
| DF1.6 | `df1-6-team-dispatch-phase.md` |
| DF2.3 | `df2-3-provider-driver-interface.md` |
| DF1.6A / DF1.6B (post-split, SPL-008) | `df1-6a-<title>.md` / `df1-6b-<title>.md` |

The kebab title is a **short** handle (3–5 words), not the full H1. Compare the
exemplars: H1 "P1.6: Pi-Team Implement via CLI-Anything Warren Harness + Captures
Structured JSON" → slug `p1-6-pi-team-protocol-step.md`.

Story files land in the sprint's `stories/` directory — for this DF v5 run,
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/` per the directory contract
in `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md` §1; other
epics resolve their own `{STORY_DIR}` the same way. The H1 inside the file is the
full title with the `{STORY_ID}: ` prefix.

---

## 6. Pre-write checklist for writing agents

Run this before returning each story.

- [ ] Total lines ≤ 400; normative lines (excl. Dev Agent Record) ≤ 200
- [ ] Story Points ≤ 5 (split at ≥6 per SPL-006, well inside the ≤8 BLOCK)
- [ ] DOD items ≤ 10, zero project-wide CI invariants among them
- [ ] Title contains ≤ 1 of `and` / `&` / `+`
- [ ] Zero occurrences of `⛔`, `pending sign-off`, `TBD on`
- [ ] `## Files to Modify` present, ≤ 10 unique paths, tests included
- [ ] `## Security Invariants` present with concrete named `INV-N` (not `N/A`)
- [ ] `## Trigger Surface` present; every invoking entry point is in-scope-with-test
      or out-of-scope-with-follow-up-ID (SPL-014)
- [ ] `## Infra Prerequisites` present; every "Lifecycle Hook Verified" cell populated (SPL-015)
- [ ] AC1 marked `**(make-or-break)**`; a failure-path AC and a boundary AC both present
- [ ] Last DOD item is `**Test (e2e demo — MANDATORY):**` naming an observable artifact
- [ ] Every contract either cites v5 §5.2 or is newly introduced by this story
- [ ] No reconciliation prose, no `{STORY}-R{n}-{n}` finding IDs, no restated debates

---

## 7. Conflicts and notes for the orchestrator

1. **DOD count conflict — resolved in favor of ≤10.** The skill body
   (`.claude/commands/skills/qds-sprint-planning.md` §Quality Requirements line 615,
   and §Quality Bar line 697) still mandates **"20–36 DOD checkboxes across 6
   categories"** and holds up the A6 stories (21–36 checkboxes) as the quality bar.
   Phase 2.5 check 4 caps DOD at **≤10 high-signal items**. These are irreconcilable.
   Phase 2.5 is the gate that actually runs, it postdates the Quality Bar section, it
   was added precisely because 26–40-item DODs produced 15+ fix rounds on PR #1394,
   and the audit's own tie-break rule is "the more restrictive limit wins."
   **DF stories target ≤10.** Someone should fix the skill body; that is out of R1's
   scope but worth an issue.

2. **The BMAD base template is not the QDS shape.**
   `~/.claude/skills/bmad-create-story/template.md` is the generic BMAD story
   skeleton (`Status`, `Tasks / Subtasks`, `Dev Notes`, `References`). It contains
   **no** `## Security Invariants` section and **no** keyword list, despite
   `phase-2-5-atomicity-audit.md` §"Cross-skill contract" and SPL-016 both naming it
   as the canonical source of that list. The cross-skill contract is currently broken;
   the only live copies of the keyword list are the atomicity audit and the skill body.
   The QDS shape (Spec Reference / E2E Slice / Files to Modify / Security Invariants)
   is the one to follow — it is what the gate audits and what the exemplars use.

3. **Trigger Surface and Infra Prerequisites are new sections.** Zero existing story
   in `_bmad-output/` contains either. SPL-014 and SPL-015 mandate them via
   `enforcement_template` blocks in `patterns.yml` but no story has yet been written
   under those rules. The DF stories are the first. The table shapes in §3 above are
   transcribed from those enforcement templates.

4. **DF v5 stories must not inherit P1.6's warren exit-code table.** F3 in the v5
   adversarial record establishes that the assumed 0/1/2/3 mapping is contradicted by
   warren v0.14.1's published table, and that SPIKE-3 never ran to verify it. Any DF
   story touching runtime exit codes derives its mapping from the runtime's published
   documentation and cites it (see §4.5).

5. **`## Dev Agent Record`** with the HTML-comment placeholder appears on P1.6 and
   P1.15 but not P1.13. Include it — the audit explicitly excludes it from the
   normative line count, so it is free, and `qds-dev` fills it during development.
