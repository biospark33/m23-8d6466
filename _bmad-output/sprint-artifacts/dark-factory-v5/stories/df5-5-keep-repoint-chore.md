# DF5.5: KEEP-Repoint Chore — Dependency Edges, Boundary Amendments, SwarmClaw Role Line

**Story Points:** 2
**Sprint:** v5-S3 — applied last, after all repoint-target stories are merged and the DF slate IDs
are frozen

## Spec Reference

- `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` §2 (the 30-row disposition table;
  amendment allowance at line 24 — "dependency-edge repoints … and single-line factual amendments
  … are allowed under KEEP; anything touching an AC's substance is not")
- Decision register: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **§4** (boundary contracts DF1.3↔P1.9, DF1.5↔P1.5), **DD-2** (P1.18 repoints to DF6.1),
  **DD-7** (SwarmClaw role), **DD-8** (audit §3 label erratum — verify before citing)
- Sizing/graph: `R5-dependency-sizing.md` §1.5 (this row), §2 (successor map), §5.2, §5.4

## User Story

As a developer picking up a KEEP story after the v5 re-derivation,
I want every retired story ID in that file replaced by its DF successor and every ownership
boundary stated in the file itself,
so that I do not build against a dead premise or ship a second copy of something a DF story owns.

## Overview

Eleven phase-0/phase-1 stories keep the **KEEP** disposition and stay in place at
`_bmad-output/sprint-artifacts/phase-{0,1}/stories/`: `p1-{2,3,5,7,9,11,12,14,18}` plus `p0-5` and
`p0-9`. `p0-7` is **DONE-KEEP** and is in this chore's scope too — it carries retired IDs and takes
the DD-7 role line — so **12 files are in the verification greps** (the 11 KEEP + P0.7).

Those two counts are not the same set, and the difference is the whole point of the distinction:
**`p0-5` has zero hits and is never amended**, so the chore touches **11 files**, which are:

- `phase-1/stories/`: `p1-2`, `p1-3`, `p1-5`, `p1-7`, `p1-9`, `p1-11`, `p1-12`, `p1-14`, `p1-18`
- `phase-0/stories/`: `p0-7`, `p0-9`

Eleven of the 12 still name story IDs the v5 derivation retired, or sit on a boundary a DF story now
owns — ten carry retired IDs (the amendment-A occurrence table) and `p1-5` is boundary-only
(amendment C, zero retired-ID hits); the union is eleven, which is exactly the amended-file set.
This chore applies the enumerated edit list in §Technical Notes: dependency-edge repoints
against the successor map, two additive boundary statements, one SwarmClaw role line, and recorded
dispositions for three instructions that survived into the amendment set but have no work left in
them — the audit's two enum-citation fixes (both verified NOT-FOUND — see amendment B) and the DF2.3
ceiling-chain tightening (verified already-satisfied — see amendment E). Every edit in the 11 amended
files carries the literal marker `v5 amendment (DF5.5)` so the whole change set is one grep away.

## E2E Slice

**Demonstrable behavior:** Given the DF slate frozen at 31 IDs, When the chore is applied, Then the
**retired-ID grep** over the 12 in-scope files returns **zero lines** — every surviving mention of a
retired ID names its DF successor on the same line — and the **marker grep**, scoped to the two
story directories and sorted, returns exactly the 11-path amended-file list:

```
grep -rl 'v5 amendment (DF5.5)' \
  _bmad-output/sprint-artifacts/phase-0/stories/ \
  _bmad-output/sprint-artifacts/phase-1/stories/ | sort
```

The scoping is load-bearing: the literal `v5 amendment (DF5.5)` also occurs in this story file, in
the epics doc and in the regression test, so an unscoped `grep -rl` returns 13+ paths and can never
equal 11. Every marker this chore writes lands inside those two directories: no amendment edits a
file outside them.

**Wiring closed:** On completion of this story, no KEEP story points a developer at a retired ID or
at an unowned boundary, using only edits merged by this story. No stub, no `TODO: wire later`, and
no sibling story is required. This is a documentation chore: it changes no code and no AC substance.

**Dependency edges (predecessors):** DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3,
DF6.1 — the
successor IDs this chore actually writes into a file (amendments A, C and D; E is retired as
already-satisfied and writes nothing). The chore is scheduled
after the whole 31-ID slate freezes, but a frozen ID that appears in no amendment is not an edge.

## Acceptance Criteria

1. **(make-or-break)** Given amendments A–E in §Technical Notes, When the chore is applied, Then both
   verification greps pass:
   - **Retired-ID grep** over all 12 in-scope files (11 KEEP + P0.7, phase-0 included):
     `grep -rnE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b' _bmad-output/sprint-artifacts/phase-1/stories/p1-{2,3,5,7,9,11,12,14,18}-*.md _bmad-output/sprint-artifacts/phase-0/stories/p0-{5,7,9}-*.md | grep -v 'DF[0-9]'`
     returns **zero lines**.
   - **Marker grep** scoped to the two story directories (see §E2E Slice), sorted, returns **exactly
     the 11 amended paths** — `p0-5` is absent because it has zero hits and is never opened.

   The `grep -v 'DF[0-9]'` filter only proves an annotation exists on the line, not that it is the
   *right* successor, so it is backed by a **table-driven per-pair assertion** in
   `tests/backlog/keep-repoints.test.ts`: for each `(file, retired ID, successor ID)` triple in the
   successor map, every surviving line in that file mentioning the retired ID must also mention its
   mapped `DF<x>.<y>` **on the same line**, and a line naming a *different* DF ID MUST fail.
   *Negative control: a find-and-replace that rewrites historical provenance references
   ("shipped PR #40/#87") into DF IDs passes the plain grep but destroys the record and MUST fail
   review — forward-looking references are repointed, provenance references are annotated.*
2. Given amendment C, When P1.9 and P1.5 are read, Then each names the DF story that owns the
   adjacent scope (DF1.3 owns in-phase retry; DF1.5 owns the roster config schema + dual slug
   validation), and neither file's Acceptance Criteria block has changed by a single character.
3. Given amendments A and D, When `p0-7-swarmclaw-agent-mcp-hindsight.md` is read, Then it carries the
   one-line DD-7 role statement below its H1 **and** the amendment-A edits at L55 and L136, and no
   P0.7 **AC, DOD item, or shipped asset** is modified — P0.7 stays frozen DONE-KEEP. The two
   amendment-A edits are narrative and illustrative-comment text, not assets: L136 is a
   downstream-contract paragraph whose three forward-looking `P1.1` mentions are repointed to `DF3.1`,
   and L55 is a comment inside an illustrative snippet describing a shipped registration requirement,
   so it keeps `P1.1` and gains the provenance annotation `(now DF3.1)`. No schema name, no
   endpoint and no code line under P0.7 changes.
4. **(failure path)** Given the amendment set, When the chore runs, Then **every successor ID written
   by any amendment** — the mapped `DF<x>.<y>` targets of amendments A, C and D (DF1.3, DF1.5,
   DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1) — is confirmed to
   resolve to an existing file under `_bmad-output/sprint-artifacts/dark-factory-v5/stories/` before
   the first edit; if any does not, the chore stops and records the missing ID in the amendment log
   rather than writing a dangling pointer. The precondition is over IDs the amendments actually
   write, not over the full 31-ID slate.
5. **(boundary)** Given a story with the **RETIRE** disposition (P0.1, P0.4, P0.8, and the RETIRE
   rows of audit §2), When the chore runs, Then that file is not opened for edit — retired stories
   are historical record. This is the disposition recorded for amendment B's only real hit.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Developer applies the chore once, by hand, after the slate freezes | in-scope | `tests/backlog/keep-repoints.test.ts` (runs both verification greps) | — |
| CI regression check on `_bmad-output/sprint-artifacts/**` | in-scope | same test, run in the standard suite | — |
| `sprint-status.yaml` DF epic blocks + per-story disposition marks | out-of-scope | — | Phase 3 wrap-up (register §1), not a story |
| Any automated rewrite of story markdown | out-of-scope | — | none — SPL keeps story edits human-authored |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| KEEP story files | git working tree, `_bmad-output/sprint-artifacts/phase-{0,1}/stories/` | files present on branch at apply time (`ls` before edit) |
| DF slate files | git working tree, `.../dark-factory-v5/stories/` | every successor ID written by an amendment (DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1) resolves to a file on disk — AC4's precondition check |
| Verification greps | `grep -rnE` in the repo test suite | `tests/backlog/keep-repoints.test.ts` executes the retired-ID grep, the directory-scoped marker grep and the table-driven per-pair assertion, and asserts on their output |

No deployed component: this story ships markdown only.

## Technical Notes

- **Successor map (binding; source R5 §2 + audit §2):** P1.1→DF3.1 · P1.4→DF1.1 · P1.6→DF1.6 ·
  P1.8→DF1.8 · P1.10→DF3.4 · P1.13→DF2.8 · P1.15→DF5.2 · P1.16→DF5.3 · P1.17→DF5.4 · P1.19→DF6.1.
  P1.4/P1.10/P1.16/P1.17 appear in **no** KEEP story; their rows exist for the epics index.
- **Amendment A — dependency-edge repoints.** Occurrence lines verified 2026-08-11 by
  `grep -onE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b'`; re-verify before editing and record drift.

  | KEEP file (`phase-1/stories/` unless marked) | Lines | Repoint |
  |---|---|---|
  | `p1-2-qds-intake-issue.md` | 26 | P1.1 → DF3.1 |
  | `p1-3-seeds-decompose-mirror.md` | 22, 24, 39, 46, 138, 142, 147, 154, 155 | P1.1 → DF3.1; P1.6 → DF1.6 (L46) |
  | `p1-7-lsp-diagnostics-gate.md` | 26 | P1.6 → DF1.6 |
  | `p1-9-restart-policy.md` | 25 | P1.8 → DF1.8 |
  | `p1-11-hindsight-prime-retain.md` | 25, 48, 51 | P1.6 → DF1.6 (25, 51); P1.1 → DF3.1 (48) |
  | `p1-12-mulch-prime-record.md` | 25, 31, 39 | P1.6 → DF1.6 |
  | `p1-14-outcome-record-router.md` | 24, 26 | P1.13 → DF2.8 |
  | `p1-18-pr-comment-polling.md` | 17, 23, 25, 50 | P1.15 → DF5.2 (17, 23, 25); P1.19 → DF6.1 (50) |
  | `p0-9-hindsight-banks-mulch.md` (**`phase-0/`**) | 198, 218 | P1.6 → DF1.6 (198, mulch-priming consumer contract); P1.1 → DF3.1 (218, JSON-RPC error-code range allocation) |
  | `p0-7-swarmclaw-agent-mcp-hindsight.md` (**`phase-0/`**, DONE-KEEP) | 55, 136 (×3) | L136: all three `P1.1` → DF3.1 (downstream-contract-stability paragraph — forward-looking); L55: `P1.1` **kept**, annotated `(now DF3.1)` — a comment in an illustrative snippet describing a shipped registration requirement, so provenance rule applies |

  The rows above are the complete occurrence set for the 12 in-scope files. `p0-5` has zero hits and
  is not opened; `p0-9` and `p0-7` are the two phase-0 files carrying retired IDs. Rule:
  **forward-looking** references (dependency edges, integration points, downstream
  consumers) are repointed. **Provenance** references (a shipped PR, a merged asset, a shipped
  requirement quoted in a snippet) keep the old ID and gain a `(now DF{n}.{m})` annotation — the old
  ID is what the git history says. The P1.19 → DF6.1 repoint at `p1-18:50` was formerly tagged
  "amendment E"; it is an ordinary amendment-A dependency-edge repoint and is folded into this table.
  The letter E is not vacant — it names the DF2.3 ceiling-chain instruction below, retired as
  already-satisfied.
- **Amendment B — the two enum-citation fixes are NOT-FOUND; record, do not invent.** Audit §2
  rows 92/95 instruct fixing a stale 4-value enum citation at `p1-11-hindsight-prime-retain.md:44`
  and `p1-14-outcome-record-router.md:29`. Verified 2026-08-11: **`exitStatus` occurs zero times in
  either file**; L44 of P1.11 is a Hindsight REST transport table row and L29 of P1.14 is blank.
  This is a DD-8-class label/line drift. Repo-wide sweep found exactly one 4-value listing in the
  whole story corpus — `exit_class` enum: `success | transient | overflow | logic` at
  `p0-4-hard-guard-kill.md:39` — and **P0.4 is RETIRE** (audit §2 phase-0 row), so per AC5 it is
  not edited. Disposition: record both NOT-FOUNDs and the sweep result in the amendment log; the
  CC-1 5-value enum (`success | transient | overflow | logic | lead_failure`) needs no correction
  in any KEEP story. Same sweep, adjacent drift: `p1-14-outcome-record-router.md` names
  **`costCents`** at :30 (AC1), :37, :40, but DD-9 settles the unit as integer µ$. An AC field name
  is AC substance — INV-1 forbids the edit; record it, and DF2.8 restates the cap (5,000,000 µ$).
- **Amendment C — boundary statements (register §4), additive, AC-untouched.** Insert one
  blockquote immediately after each file's `**Dependency edges (predecessors):**` line:
  - `p1-9-restart-policy.md`: P1.9 owns **cross-run** restart classification keyed on the CC-1
    exitStatus enum. **In-phase** retry — JSON-parse and gate-violation retries re-entering the
    same agent session — is **DF1.3's**, separately bounded.
  - `p1-5-model-router-hindsight.md`: P1.5 owns **router scoring against outcome records** (step
    6). The roster **config schema and dual slug validation** (pi's bundled catalog AND the
    provider API, plus `~/.pi/agent/models.json`) is **DF1.5's**.
- **Amendment D — DD-7 SwarmClaw role line.** One blockquote below the H1 of
  `p0-7-swarmclaw-agent-mcp-hindsight.md`: *SwarmClaw's v5 role is the host-side service chassis
  for factory query surfaces — the natural HTTP home for DF5.3's audit-chain query and DF2.8's
  cost view if either needs one. It is **not** the factory front door; that is the tier-1 CLI
  (DD-1/DD-7). P0.7 assets stay frozen; no AC changes.*
- **Amendment E — the DF2.3 ceiling-chain tightening is ALREADY-SATISFIED; record, do not rewrite.**
  E formerly instructed a single-line wording amendment to `dark-factory-v5/stories/df2-3-*.md`,
  tightening a non-strict chain (`run-key cap ≥ DF2.8 budget cap ≥ DF3.6 per-run ceiling`) so the
  budget ↔ resident pair reads strict. Verified 2026-08-12: **`df2-3` already carries DF3.6's strict
  chain verbatim** — `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`, with
  DF3.6's `loadResidentBounds` named in the same paragraph as its single owner — put there by an
  earlier fix in this review campaign, before this chore was ever scheduled. There is nothing left to
  amend, and re-applying E would rewrite a correct copy into a second, looser phrasing of the same
  invariant. Disposition (same shape as amendment B): record the verification and its command in the
  amendment log; **`df2-3` is not opened for edit**, DF3.6 is not an edge of this chore, and no
  successor-ID precondition is run for it. This is why the chore edits nothing outside
  `phase-{0,1}/stories/` and why every marker it writes lands in the 11-path count.
- **Deviation/assumption:** line numbers above are a snapshot. If any has drifted at apply time,
  the chore records the actual line in the amendment log and proceeds — the grep in AC1, not the
  line number, is the acceptance signal.

## Observability Contract

- The amendment log lives in this story's `## Dev Agent Record`: one row per edit —
  `{ file, line, before, after, amendment }` — plus amendment B's NOT-FOUNDs and drift record.
- Both AC1 greps are recorded with their exact command line and output at apply time; a non-empty
  result is a failure, not a note.

## Files to Modify

Story paths are relative to `_bmad-output/sprint-artifacts/`; the test path is repo-root.

Eleven amended files (the marker set), plus the log:

- `phase-1/stories/p1-{2,3,7,11,12,14,18}-*.md` — amendment A
- `phase-0/stories/p0-9-hindsight-banks-mulch.md` — amendment A (L198, L218)
- `phase-1/stories/p1-9-restart-policy.md` — amendments A + C
- `phase-1/stories/p1-5-model-router-hindsight.md` — amendment C
- `phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md` — amendments A (L55, L136) + D
- `dark-factory-v5/stories/df5-5-keep-repoint-chore.md` — amendment log

`phase-0/stories/p0-5-pi-lens-headless-tdi.md` is in the verification-grep scope and **not** in this
list: zero hits, never opened.
- `tests/backlog/keep-repoints.test.ts` — both verification greps as a regression test

## Security Invariants

- INV-1: **Edit scope is bounded to non-normative text.** No `## Acceptance Criteria`,
  `## Definition of Done`, or `## Security Invariants` line in **any file this chore edits** changes —
  the eleven amended files, ten KEEP plus `p0-7-swarmclaw-agent-mcp-hindsight.md`'s DONE-KEEP — the
  audit's amendment allowance covers dependency edges and single-line factual statements only.
  Enforced by reviewing the diff per file: an AC-line hunk is a rejection.
- INV-2: **Retired files are immutable.** Stories with the RETIRE disposition are never opened for
  edit, including `p0-4-hard-guard-kill.md` where the only true stale-enum hit lives (AC5).
- INV-3: **Closed records are not modified.** The design doc, the disposition audit, and the gates
  report are closed; every correction this chore discovers (amendment B's NOT-FOUNDs, the
  `costCents` drift) is recorded
  in the amendment log and, if it changes a decision, in the decision register — never by editing
  a closed record.
- INV-4: **No dangling pointers.** A successor ID is written only after its story file is confirmed
  present on disk; a missing target halts the chore (AC4) rather than producing a reference that
  resolves to nothing.

## Definition of Done

- [ ] **Impl:** Amendment A applied across the ten files in the occurrence table (P0.9 and P0.7
      included), forward-looking references repointed and provenance references annotated.
- [ ] **Impl:** Amendment C's two boundary blockquotes inserted in P1.9 and P1.5.
- [ ] **Impl:** Amendment D's SwarmClaw role line inserted in P0.7.
- [ ] **Contract:** Every edit carries the literal marker `v5 amendment (DF5.5)`; the
      directory-scoped `grep -rl … | sort` returns exactly the 11 amended paths and nothing else.
- [ ] **Integration:** Amendment B's two NOT-FOUND records, the corpus-wide sweep result, and
      amendment E's already-satisfied verification are in the amendment log with the commands that
      produced them; `df2-3` appears in no hunk of the diff.
- [ ] **Security:** Diff review confirms zero AC/DOD/Security-Invariant line changes in **any file
      this chore edits** — the 11 amended files — and zero edits to any
      RETIRE'd file (INV-1, INV-2).
- [ ] **Test (unit):** `tests/backlog/keep-repoints.test.ts` asserts the retired-ID grep over the 12
      in-scope files returns zero lines and the directory-scoped, sorted marker grep equals the
      11-path list exactly.
- [ ] **Test (per-pair correctness):** the table-driven assertion over the successor map — a surviving
      retired ID annotated with the **wrong** DF successor on its line MUST fail, which the plain
      `grep -v 'DF[0-9]'` would pass (AC1).
- [ ] **Test (missing successor):** A synthetic map entry pointing at a nonexistent `DF9.9` story
      file → the chore halts and logs, and writes no reference (AC4).
- [ ] **Test (e2e demo — MANDATORY):** Run both verification greps on a clean checkout after the
      chore lands → zero unannotated retired IDs across all 12 in-scope files, and the sorted
      11-path marker set — both captured verbatim, with their exact command lines, in the
      amendment log.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
