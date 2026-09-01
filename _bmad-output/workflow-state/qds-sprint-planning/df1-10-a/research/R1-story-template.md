# R1 — Story Pattern Analysis: DF-track story-file FORMAT

**Run:** qds-sprint-planning / df1-10-a / Track A
**Subject story:** DF1.10 in-box steering executor + channel lifecycle (#181, #180)
**Sources (format exemplars, all read in full):**

- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-4-approval-gate-attach-steering.md` (883 lines; 376 normative)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-9-lean-worker-profile.md` (432; 246 normative)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-6-dispatch-task-team-runtime.md` (466; 317 normative)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-6-resident-agent-bounds.md` (302; 282 normative) — nearest sibling domain
- `_bmad-output/sprint-artifacts/dark-factory-v5/atomicity-audit-2026-08-20.md` (gate rules)
- `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-2-dispatch-refusal-verdict-integrity.md` (the one issue-driven story — closest analog to DF1.10's provenance)
- `.claude/commands/skills/qds-sprint-planning.md` (§Quality Requirements, §Dual Output, §A6) and `.claude/skills/qds-sprint-planning/steps/phase-2-5-atomicity-audit.md` (the 8 checks)
- `.claude/skills/qds-live-e2e/SKILL.md` (TIER conventions)

All line citations below are `file:line` into those exemplars unless prefixed.

---

## 1. Section skeleton, in order (exact)

Union of headers across all 31 DF stories (frequency): `User Story` 32, `Spec Reference` 32,
`Trigger Surface` 31, `Technical Notes` 31, `Security Invariants` 31, `Overview` 31,
`Observability Contract` 31, `Infra Prerequisites` 31, `E2E Slice` 31, `Dev Agent Record` 31,
`Definition of Done` 31, `Acceptance Criteria` 31, `Files to Modify` 30.
**No DF story has a 12-Factor / UI Compliance / Non-goals / Integration-points / Dependencies section.**

Normative order (everything the writer writes):

```markdown
# DF1.10: <Title>

**Story Points:** <2..8>
**Sprint:** v5-S<N> (<free-text band note>)

## Spec Reference
## User Story
## Overview
## E2E Slice
## Acceptance Criteria
## Trigger Surface
## Infra Prerequisites
## Technical Notes
## Observability Contract
## Files to Modify
## Security Invariants
## Definition of Done
## Dev Agent Record          <- placeholder only at write time
```

Dev-time / append-only additions that appear later (never authored by the writer):
`---` + `## Hardening Revision — <date>` (6 stories), `## Review Findings — round N (date, tool, PR #)`
(df3-4 has rounds 6–10), and inside Dev Agent Record: `### Deviations from the story spec`,
`### Implementation Plan (as built)`, `### Debug Log`, `### Completion Notes`, `### Gates`,
`## File List`, `## Change Log`, `## Status` (df1-3:241-371). A writer emits **only** the
placeholder: df3-6:283-285 is the canonical form:

```
## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
```

### 1.1 Header fields — exact lines

**Only two `**Field:**` lines follow the title. There is NO Status, no Dependencies, no Owner,
no Epic field in the header block.** Verified across all 31 story headers.

```markdown
# DF3.4: Tier-1 Pre-PR Approval Gate + `attach` Steering

**Story Points:** 6
**Sprint:** v5-S2 (fleet band)
```
(df3-4:1-4)

```markdown
# DF1.9: Lean Worker Profile — Measure the Extension/Skill Overhead

**Story Points:** 3
**Sprint:** v5-S1 (early-safe; R5 §3 pairs it with DF2.7 — same dev, same week, same file)
```
(df1-9:1-4)

```markdown
# DF1.6: dispatch_task Phase Spawns a pi Team via `team-lead-driver.ts`

**Story Points:** 8
**Sprint:** v5-S1 (track A, engine — the flagship; R5 §3 closes S1's engine chain here)
```
(df1-6:1-4)

Title format: `# DF<epic>.<num>: <Imperative/Nominal title>` — em-dash subtitles are common
(df3-6:1, df1-9:1). Title AND-connectors ≤1 (`and`/`&`/`+`); DF3.4's title has exactly one `+`
and the audit counts it (atomicity-audit-2026-08-20.md:63). **DF1.10's title should carry at most
one connector** — note the audit would flag "steering executor + channel lifecycle" as the one
allowed `+`.

Sprint tag grammar: `v5-S1` / `v5-S2` / `v5-S3`, then a parenthetical band note that often carries
real sequencing information. `sprint-status.yaml:104` makes the story file's Sprint header the
authoritative source: *"Sprint tags per story (# v5-S1/S2/S3) come from each story file's Sprint
header."* The yaml row's trailing `#` comment must repeat the bare tag.

Where status DOES live: `sprint-status.yaml` (`status: ready-for-dev|done|in-review`), and after
dev either a `## Status` section (df1-3:368 `done — PR #112 merged 2026-08-15 (041b834)`) or a
`**Status:**` line opening the Dev Agent Record (df1-9:249). A fresh story has neither.

### 1.2 Spec Reference — two shapes

**Shape A (design-doc-derived, 29 of 31 stories)** — bullets, each naming a spec section, a
decision-register entry, a derivation decision, and binding facts (df3-4:6-15):

```markdown
## Spec Reference

- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 1, §5.3, §6 items 4/6
- Decision register: v5 §4 **D4** (tier-2 resident agent + mid-run steering), **D8** (host-side PR,
  no push credential in a box)
- Contracts: v5 §5.2 observability (requestId propagation, per-phase sub-timings)
- Ancestry: **P1.10 RE-DERIVE** — surviving clauses extracted verbatim in R2 §5
- Derivation decisions: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **DD-1** (operator-CLI-only channel for v5.0), **DD-8** (NET-NEW material authored fresh)
- Binding facts: R5 §6 facts **15** (in-box evidence is claims, not proof), **17** (host-side PR)
```

**Shape B (issue/review-driven — the shape DF1.10 must use)** — df6-2:5-11 cites code contracts
and the review evidence path instead of design sections:

```markdown
- DF1.1 lifecycle contract: `src/phase-engine/phase.ts` header ("Success is earned") — the fix closes
  a hole in that guarantee: ...
- Reviewer evidence: `_bmad-output/workflow-state/code-review/pr135/reports/fix-tests-b.md`
  (bottom, "Source bugs found but NOT fixed").
```

For DF1.10, mix B with one shape-A bullet for the steering contracts. Concretely the writer should
cite: GitHub **#181** and **#180** by number; DF3.4's **Deviation 12** (`df3-4:774`) and the
round-8 follow-up list (`df3-4:877-879`); `scripts/pipeline-run-remote.ts:5-19` (the HONEST LABEL
paragraph that names DF1.10 as the owner); `src/phase-engine/steering.ts`; DF2.1's `driver.exec`
port; and DF3.3's three solicitation points. Do **not** invent a design-doc § that does not bind
this story — round-6-style review treats a wrong § citation as a Deviation.

### 1.3 User Story — exact form

Three lines, comma-terminated, **no bold role marker** (this overrides the generic skill's
`As a **[Role]**` — no DF story bolds it):

```markdown
As the factory operator,
I want a run to stop dead after its bundle is verified out-of-box and wait for my explicit,
attributable approval before a PR is opened — and a way to steer a live run before it gets there,
so that the only thing standing between a green bundle and a public PR is a named human.
```
(df3-4:19-22)

Role vocabulary in this track: *the factory operator* (df3-4:19), *a factory operator paying for
every agent turn* (df1-9:20), *a factory engineer* (df1-6:14), *the factory host paying for every
sandbox* (df3-6:16). The "so that" clause states an invariant, not a feature.

### 1.4 Overview

One paragraph (df3-6:22-29 is the tight model — 8 lines), naming the entry-point symbols it adds
(`loadResidentBounds(manifest)`, `checkBounds(point)`), who validates what at load vs per-call,
and the fail-closed posture. Second person never appears; present tense; no bullet points.

### 1.5 E2E Slice — three labelled sub-blocks

This is the section the DF track substitutes for the generic skill's "Integration points". Exactly
three bold lead-ins (df3-4:41-64, df3-6:33-52, df1-9:40-52):

1. `**Demonstrable behavior:**` — one Given/When/Then run of the actual E2E fixture with the
   observable artifact named (`out.json`, `artifacts/lean-worker-benchmark.json`) and the exact
   values asserted.
2. `**Wiring closed:**` — the load-bearing honesty formula, near-verbatim across stories:
   *"On completion of this story, … using only code merged by this story plus <predecessor names
   with the specific contract each supplies>. **No stub, no `TODO: wire later`.**" Then the
   single-owner clause where a caller is out of scope (df3-4:56-58: "The **caller** that fires
   `requestApproval` … is **DF5.1's** (single owner — see Trigger Surface)").
3. `**Dependency edges (predecessors):**` — one bolded line, comma-separated story IDs
   (df3-4:60 `**Dependency edges (predecessors):** DF2.1, DF2.3, DF2.5, DF3.1, DF3.3.`; df1-1:54
   `**Dependency edges (predecessors):** none.`). Contract-cited-but-pending predecessors get an
   inline flag (df3-1:49 "…**DF2.8 (budget cap) — contract-cited; implementation pending**").

A fourth, optional negative-edge blockquote appears when a tempting-but-wrong edge must be
refused — the model for DF1.10's "driver.exec blast radius is CRITICAL, steeringSend seam is
follow-up" exclusion (df3-4:62-64):

```markdown
**Not an edge — DF5.1 (XC-P1-18):** the AC1 "host re-verify green" precondition is satisfied in this
story's tests by a fixture ReverifyReport; the live caller is DF5.1, which lands **after** this story
and holds the edge in that direction.
```

### 1.6 Acceptance Criteria — numbering, sub-letters, negative controls

- Decimal-ordered `1.` … `N.`, 5–7 ACs (df3-4 has 7, df1-9 5, df1-6 7, df3-6 5).
- **AC1 is always the make-or-break** and is tagged inline: `1. **(make-or-break)**` (df1-9:56,
  df3-6:56) or with a phrase: `1. **(make-or-break — intent extension first, then teardown)**`
  (df3-4:68).
- Given/When/Then inside each item, then an italic negative control as the last sentence:
  `*Negative control: an implementation that meters only after the call — the obvious one —
  overshoots the ceiling by one call, passes a naive "was it stopped?" test, and MUST fail this
  one.*` (df3-6:62). The pattern is `… passes a naive <weak-test> test, and MUST fail this one.`
- Multi-step ACs use `<br />**(a)**`, `**(a2)**`, `**(b)**`, `**(c)**` inline sub-letters rather
  than nested lists (df3-4:71, 78, 97, 117). `**(a2)**` is the idiom for a re-entry/idempotency
  arm of the same AC — exactly what DF1.10's re-provision-on-failure AC wants.
- Amendments are never silent: `**AMENDED, <deferred item> (Session D).**` with the reason
  (df3-4:100).
- NET-NEW / re-derived provenance is stated inline in the AC: `*(NET-NEW per DD-8, against design
  §5.2; evidenced by F6 clause 2 — 12/12 events, 0 malformed.)*` (df1-6:70-71).

### 1.7 Trigger Surface — the non-goals section

Four-column table (df3-4:182-192). **Out-of-scope lives here, not in its own section:**

```markdown
| Trigger | Status | E2E Test | Follow-Up |
|---------|--------|----------|-----------|
| `fleet attach <run-id>` CLI | in-scope | `tests/fleet/attach.test.ts` | — |
| The **caller** that fires `requestApproval(...)` on a green host-side re-verify | out-of-scope — **DF5.1 owns exactly one caller**; this story exports the entry point and never wires a second trigger | — | DF5.1 |
| Chat/webhook approval intake (callback URL) | out-of-scope | — | none in v5.0 — **DD-1** decides operator-CLI-only; re-enters at a future vX derivation |
```

### 1.8 Infra Prerequisites — three-column table

Always present, 3–6 rows (df3-6:129-136, df1-9:88-93):

```markdown
| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
|-----------|-------------------------------|-------------------------|
| DF3.3 solicitation port | in-repo `src/phase-engine/steering.ts` (the engine-owned port; …) | `bun test tests/phase-engine/steering.test.ts` green before this story starts |
```

The third column states the *verified* hook with the refusal when it fails — never a bare "yes".

### 1.9 Technical Notes

Bulleted, `**Bold lead-in:**` per bullet, 5–9 bullets. Recurring lead-ins across the track:
`**Contracts/Schema:**` (the one place a full zod/record shape is spelled out — df3-4:218-233),
`**Guards/limits:**` (every ceiling with units and where the cap is enforced), `**Seams touched**`
(df1-9:112-121, with exact line ranges), **region ownership** blocks when a shared file has
multiple story claimants (df1-6:205-219 — *"DF2.7 owns X … DF1.9 owns Y … A change outside your
own region belongs in the owning story"*), and **always as the final bullet** `- **Deviation/assumption:**`
(28 of 31 stories end Technical Notes with exactly one; df3-4:263, df1-9:154, df3-6:216).

### 1.10 Observability Contract — the DF track's compliance section

**There is no 12-Factor Agent Compliance section anywhere in the DF track (0 of 31 stories).**
The generic skill's requirement (`qds-sprint-planning.md:660`) is overridden by this fixed
three-bullet section, present in 31/31 stories (df3-4:269-273, df3-6:223-226):

```markdown
- Every <verb> logs `{ requestId, runId, event, ... }` — `event ∈ a | b | c`. The token never appears.
- `requestId` propagates from <producer> onto every event, so <downstream> joins without a second
  key; errors carry `{ code, message, remediation }`.
- Sub-timings: `<a>_ms`, `<b>_ms`. A bound never evaluated reports `0`.
```

### 1.11 Files to Modify

- **No line hints.** Zero `:N` suffixes in any of the four exemplars' lists (verified). Line hints
  belong in Technical Notes / ACs / DoD, not here.
- 5–11 entries; **>10 is a WARN** (df3-4's 11 was flagged, atomicity-audit-2026-08-20.md:66).
- Order: new source files first, then modified source files with a parenthetical ownership note,
  then `scripts/`, then `tests/…`, then fixtures.
- Ownership annotations are mandatory on shared files (df3-4:281-289): *"`src/fleet/status.ts`
  (authored by DF3.1; this story **adds only** the approval-extension join … and changes no
  DF3.1-owned line)"*.

### 1.12 Security Invariants

Bolded named invariants, one bullet each, 5–9 items. Two naming styles coexist:

- **Flat** (S1-era): `INV-1` … `INV-5` (df1-9:182-207, df1-6, df1-1…df3-2).
- **Namespaced** (S2+ / cross-referencing stories): `INV-APPROVE-1..9` (df3-4:297-340),
  `INV-BND-1..5` (df3-6:242-267), `INV-RES-*` (df3-3), `INV-RV-*` (df5-1).

**DF1.10 should use the namespaced style** — it sits in the DF3.4/DF3.6 steering domain and must
cross-reference foreign invariants, which are always quoted verbatim in their owner's namespace
(df3-4:298 `P1.10 INV-POLICY-2, verbatim`; df3-4:257 `DF2.3 INV-CRED-3`). No `INV-IBOX-*`,
`INV-STEER-*`, `INV-INBOX-*` or `INV-EXEC-*` exists anywhere in the track — any of those is free;
`INV-IBOX-N` (in-box) is the closest fit to the issue language and is collision-free.

Each bullet = one falsifiable claim + its enforcement locus + the citation that binds it, e.g.
df3-6:242-245: `**INV-BND-1 (enforcement locus — F12, verbatim intent):** all three bounds are
enforced by the phase engine, never by the agent. … A bound value read from a path the resident can
write is a defect regardless of the value it holds.` The Phase-2.5 gate requires this section to be
substantive whenever the body mentions auth/credential/parse/permission — DF1.10 triggers on
"credential", "parse" and "permission" by construction, so it is BLOCK-if-absent.

### 1.13 Definition of Done

**Exactly 10 checkboxes** is the target; the hard cap is ≤10 WARNed at 11. Category lead-ins
(df3-4:344-375, df3-6:271-281):

`**Impl:**` (1–2) · `**Contract:**` (1) · `**Integration:**` (1) · `**Security:**` (1) ·
`**Test (<slice name>, ACn/INV-n):**` (5–6, one per AC cluster with the AC/INV id in parens) ·
and **always last**: `**Test (e2e demo — MANDATORY):**` (present in 25/31 stories).

Every item names the artifact a reviewer can check (`tests/fleet/attach.test.ts`, `out.json`),
and Test items carry the MUST-fail clause: *"…teardown-before-extension MUST fail."* (df3-4:359).

---

## 2. Repo-specific norms that override the generic skill

| Generic skill says | DF track does | Evidence |
|---|---|---|
| Brief epic summary inserted into `_bmad-output/epics.md` | **No epics.md exists and no DF story references one** (0 hits across 31 stories; `find _bmad-output -name epics.md` returns nothing). The index is `_bmad-output/sprint-artifacts/sprint-status.yaml` — per-epic blocks `df1:`…`df6:` with inline story rows. The "Output 2: Epic Summary" deliverable becomes a sprint-status.yaml row. | `qds-sprint-planning.md:102` ("Stories: sprint-artifacts/dark-factory-v5/stories"); `sprint-status.yaml:104` (Sprint tags come from the story header) |
| `As a **[Role]**` bolded | unbolded, three-line | df3-4:19-22 |
| 12-Factor Agent Compliance (Track A) | `## Observability Contract` (31/31) | df3-4:267, df3-6:221 |
| 20–36 DoD checkboxes (A6 standard) | 10 high-signal; the gate wins over the A6 table (`qds-sprint-planning.md:661-667`) | df3-4 has exactly 10 |
| Story file at `sprint-N/stories/` | `_bmad-output/sprint-artifacts/dark-factory-v5/stories/dfN-M-<kebab-slug>.md` | all 31 |
| `### Story {EPIC}.{NUM}:` headings | `# DF{N}.{M}: {Title}` H1, no `### Story` prefix | df3-4:1 |

**Points conventions:** 2–8 SP, ≤8 is a BLOCK gate (audit check 3). Distribution in the track:
chore/measure = 2 (df2-7, df3-5, df6-2), bounded mechanism = 3–5 (df3-6 = 3, df3-1 = 5),
two-surface story = 6 (df3-4's gate + transport). DF1.10 spans a consumer **and** a lifecycle
re-provision, and must keep the driver out of scope (round-8 deferred item: `ExeDevDriver.exec`
blast radius CRITICAL, 27 symbols — `df3-4:783`) → **5 or 6 SP** is the right band; 6 matches
DF3.4, the nearest-sibling two-surface story.

**Sprint header:** DF1.10 is new. Use the existing grammar, e.g. `**Sprint:** v5-S2 (fleet band,
unslotted fix; closes #181/#180 — mirrors DF6.2's "unslotted fix" precedent at df6-2:4)` or attach
to whichever sprint the orchestrator slots. The yaml row then gets `# v5-S<N>` + a one-line note.

---

## 3. Size discipline

**Normative-line counting method** (audit, atomicity-audit-2026-08-20.md:10-12): *total lines minus
the Dev Agent Record block and trailing appendix.* Practically: **everything up to and including
`## Definition of Done`**. The `---` + `## Hardening Revision` appendix and `## Review Findings —
round N` blocks are append-only and never counted (df3-4 is 376 normative of 883 total; 507 lines
are dev-time appendices).

Measured:

| Story | total | normative (`## Dev Agent Record` line − 1) | DoD items | ACs | Files |
|---|---|---|---|---|---|
| df3-4 | 883 | **376** (1–376) | 10 | 7 | 11 |
| df1-6 | 466 | **317** (1–317) | 15 | 7 | 10 |
| df1-9 | 432 | **246** (1–246) | 9 | 5 | 9 |
| df3-6 | 302 | **282** (1–282) | 11 | 5 | 5 |

All four BLOCKed the ≤200 gate in the 2026-08-20 audit (357/314/259/283 at audit time) and were
**operator-overridden** as inherited SPL-027 debt (audit :96-119). Do not inherit that posture:
the command file sets the writer target at **≤185 normative lines** with the explicit rationale
*"The 200-line cap belongs to the Phase-3 adversarial loop, which needs ~15 lines of headroom …
writers who aim at the cap converge at 195–200 and force review fixes to be declined for line
budget"* (`qds-sprint-planning.md:669-673`). Total-file WARN is 400.

**Budget to hit 185** (derived from df3-6:1-282 and df1-9:1-246 section spans, compressed):

| Section | Lines | Notes |
|---|---|---|
| header (title + 2 fields) | 4 | |
| Spec Reference | 8–10 | Shape B for DF1.10 — issue + code citations, no design-§ padding |
| User Story | 5–6 | |
| Overview | 9–11 | |
| E2E Slice | 15–18 | the three bold lead-ins + Not-an-edge blockquote |
| Acceptance Criteria | 28–34 | 6 ACs; AC1 tagged make-or-break; keep negative controls to one line each |
| Trigger Surface | 10–12 | 5–7 rows incl. 2 out-of-scope |
| Infra Prerequisites | 8–10 | 3–4 rows |
| Technical Notes | 35–42 | 6–7 bullets incl. the closing `Deviation/assumption:` |
| Observability Contract | 6–7 | 3 bullets |
| Files to Modify | 10–11 | ≤10 to avoid the WARN |
| Security Invariants | 16–20 | 5–6 named INV-* |
| Definition of Done | 14–16 | 10 boxes |
| **Total** | **≈175–190** | leave the last ~10 lines unspent for review |

---

## 4. AC numbering + invariant namespaces actually used

- **AC:** decimal `1.`–`7.`, AC1 `**(make-or-break…)**`; sub-arms `<br />**(a)/(a2)/(b)/(c)**`
  (df3-4:71-118); amendments inline as `**AMENDED, …**` (df3-4:100, df3-4:323).
- **Own invariants:** `INV-<DOMAIN>-<N>`. Namespaces taken: `APPROVE` (df3-4:297-340),
  `BND` (df3-6:242-267), `RES` (df3-3), `RV` (df5-1), `CRED` (**df2-3:180-199** —
  `INV-CRED-1` scoping, `INV-CRED-2` provisioning-key containment, `INV-CRED-3` delivery
  "secrets travel over **stdin, never argv**", `INV-CRED-4` revocation proof, `INV-CRED-5`
  fail-closed ordering, `INV-CRED-6` prefix defense), `POLICY` (P1.10 ancestry, referenced by
  df3-4:298-308). Both styles coexist in S1 (`INV-1..5` flat in df1-1…df3-2), but **any story
  whose invariants get quoted by siblings is namespaced** — df2-3 is S1 and uses `INV-CRED-*`
  precisely so df2-2:186, df2-4:214, df2-8:260, df3-4:257 and df5-2 can quote it unambiguously.
  **Free: `IBOX`, `STEER`, `INBOX`, `EXEC`.**
- **Foreign invariants are never renumbered** — quoted verbatim in the owner's namespace with a
  parenthetical (df3-4:257 *"Token read from **stdin, never argv** (DF2.3 INV-CRED-3)"*).
- **Other tracked ids a DF story cites:** `D1..D9` (design decision register), `DD-1..DD-9`
  (derivation decisions), `F1..F15` (findings), `CC-1..CC-14` (cross-cutting contracts),
  `R1..R5` (research agents), `OQ-*` (open questions), `XC-P1-18` (cross-epic edge), and
  R5 §6 fact `N`. DF1.10's natural citations: D4 (resident + steering), F12 (watchdog locus),
  CC-1 (`exitStatus` enum), R5 §6 fact 15, plus #181/#180.

---

## 5. Live E2E / TIER conventions a DF1.10 story must encode

The repo has a mandatory live-E2E culture. A story's *normative* encoding is one DoD checkbox plus
one AC; the harness mechanics live in `tests/fleet/e2e/*.live.test.ts` and are governed by
`.claude/skills/qds-live-e2e/SKILL.md` (CLAUDE.md makes the skill mandatory for live rounds).

1. **The mandatory DoD item** — always the last checkbox, `**Test (e2e demo — MANDATORY):**`
   (present in **31 of 32** DF stories — universal, not optional; the one exception is df6-2, a
   post-hoc reconciliation story whose DoD was already discharged). DF3.4's form (df3-4:373-375)
   is the model for a state-carrying demo:
   ```
   - [ ] **Test (e2e demo — MANDATORY):** one scripted run pauses, approved by allowlisted operator
         over stdin, leaves `extensions.approval` carrying `approved` + `approverId` + `decidedAt` —
         DF5.2 gates the PR on this.
   ```
   State the exact artifact + the exact fields asserted + who consumes it.

2. **Tier language in ACs/DoD**: `TIER-1` = real boxes/keys, **zero model spend**; `TIER-2` = +
   real in-box model calls; `TIER-3` = patterns/reaper/remote-phases; `TIER-4` = resident
   orchestrator steering. The tier vocabulary is used inline at dev time as evidence
   (df3-4:112 `Verified live, TIER-1, zero model spend: real box → real fleet teardown …` — an
   AMENDED-in clause, not written at planning time) and in review findings (`T1.7`, `D8`, `T5.1`,
   `CC-9` are the live-harness test ids DF3.4's rounds cite; `tier4-resident` per
   `qds-live-e2e/SKILL.md:64`). Live tests gate on `test.todoIf(!process.env.QDS_E2E_LIVE)` with
   `QDS_E2E_TIER` selecting the tier, evidence JSON to `_bmad-output/evidence/df3-e2e/`
   (`SKILL.md:32-66`). **A story must not promise a live run in its ACs** — it promises the demo
   artifact and lets the dev agent pick the tier; DF3.4's AC6 instead pins the *substrate*: "a live
   box under the `fake` driver running DF1.1's engine with a DF3.3 resident" plus the negative
   control *"a test that asserts only against DF3.3's channel double … MUST NOT be the sole
   evidence for this AC"* (df3-4:159-171) — that no-doubles clause is exactly what DF1.10's
   round-trip AC needs, since Deviation 12's whole point is that a channel double cannot see the
   host/box split.

3. **Naming the follow-on issues**: DF3.4 round 8 files the two seams DF1.10 owns as "Follow-up
   GitHub issues (future-story seams, tracked — not lost)" (`df3-4:877-879`) and its Deferred list
   adds a third, easy to miss: *"Cross-process ack-provenance surfacing on the attach CLI
   (engine-side count shipped; **the CLI join needs DF1.10's executor contract**)"* (`df3-4:784`).
   DF1.10's Trigger Surface should carry that as an in-scope or explicitly-deferred row, and its
   Spec Reference should cite all three (#180, #181, and the ack-provenance CLI join).

---

## 6. Writer checklist (the one-page contract)

1. `# DF1.10: <Title>` + `**Story Points:** 5|6` + `**Sprint:** v5-S<N> (<band note>)`. Nothing
   else in the header.
2. Spec Reference = Shape B: #181, #180, `pipeline-run-remote.ts:5-19`, `src/phase-engine/steering.ts`,
   DF2.1 `driver.exec` port, DF3.3's three solicitation points, DF3.4 Deviation 12 + round-8
   follow-ups (df3-4:774, 783-784, 877-879).
3. User Story — 3 unbolded lines, factory-operator/host role.
4. Overview — one paragraph, names the new symbols and the fail-closed posture.
5. E2E Slice — `**Demonstrable behavior:**` / `**Wiring closed:**` (the "No stub, no `TODO: wire
   later`" sentence, verbatim) / `**Dependency edges (predecessors):**`; optional
   `**Not an edge — …**` blockquote excluding `ExeDevDriver.exec` changes.
6. ACs — 5–7, AC1 `**(make-or-break …)**`, one AC carries `<br />**(a)/(a2)**` re-provision
   idempotency arms, italic negative controls with "MUST fail this one".
7. Trigger Surface table (in-scope rows → test file; out-of-scope rows → owning story).
8. Infra Prerequisites table — steering channel paths, DF3.3 port, driver verbs, telemetry sink.
9. Technical Notes — `**Contracts/Schema:**` (the NDJSON line shapes for inbox/acks + the
   re-provision state machine), `**Guards/limits:**` (byte caps, poll ceilings), a
   **region-ownership** bullet for `scripts/pipeline-run.ts` and `src/phase-engine/steering.ts`
   (DF3.3 authors / DF3.4 rebase / **DF1.10**), closing `**Deviation/assumption:**`.
10. Observability Contract — 3 bullets, event union, `requestId` propagation, sub-timings.
11. Files to Modify — ≤10, no `:line` hints, ownership parentheticals on shared files.
12. Security Invariants — `INV-IBOX-1..N` (or STEER), cross-refs verbatim (INV-APPROVE-5,
    INV-CRED-3), stdin/argv discipline, no-credential-in-inbox.
13. DoD — exactly 10 boxes, last one `**Test (e2e demo — MANDATORY):**`.
14. `## Dev Agent Record` + `<!-- Empty placeholder — filled during development. -->` — nothing
    after it.
15. **≤185 normative lines** (count = everything through Definition of Done), ≤400 total,
    0 blocker markers (`⛔`, `pending sign-off`, `TBD on`).
