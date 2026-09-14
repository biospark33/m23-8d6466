# DF5.5: KEEP-Repoint Chore — Dependency Edges, Boundary Amendments, SwarmClaw Role Line

**Story Points:** 3
**Status:** ready-for-dev
**Sprint:** v5-S3 — applied last, after all repoint-target stories are merged and the DF slate IDs
are frozen

*(Re-estimated 2 → 3 on 2026-09-08. The original 2 pts covered 28 mechanical substitutions plus
three blockquotes. It now also carries: eight `sprint-status.yaml` KEEP rows, a four-assertion
regression test in a file that does not exist yet, replacement **text** rather than bare
substitution for every gloss-bearing line, a new amendment F across two files, and a per-line diff
review of the four in-block edits INV-1 now admits. Roughly +50% edit volume plus one genuinely new
deliverable. Still one story — every edit shares one verification harness and one marker set, so a
split would force two stories to agree on the 11-path assertion.)*

## Spec Reference

- `docs/superpowers/specs/2026-08-11-story-disposition-audit.md` §2 (the 30-row disposition table;
  amendment allowance at line 24 — "dependency-edge repoints … and single-line factual amendments
  … are allowed under KEEP; anything touching an AC's substance is not")
- Decision register: `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`
  **§1** (module roots, `:23`), **§4** (boundary contracts DF1.3↔P1.9, DF1.5↔P1.5),
  **DD-2** (`:47`, "P1.18 (KEEP) repoints to DF6.1" — **superseded**) and **DD-2a** (`:48`, DECIDED
  2026-09-08, the amendment that supersedes it: DF6.1 split, `DF6.1` now a dangling ID, `p1-18:50`
  re-pointed to **DF6.1a** and assigned to DF6.1a's wave — **already landed, no register edit is
  owed by this chore**); see the P1.18
  disposition note in §Technical Notes), **DD-7** (SwarmClaw role), **DD-8** (audit §3 label
  erratum — verify before citing; it fires a third time here, see the amendment C erratum)
- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED) — §Consequences added
  DF2.10/DF1.10/DF1.11/DF3.7/DF3.8 and re-sequenced DF3.6 **after** this story was authored
  (2026-08-12); the slate this chore waits on is the post-ADR one, and the engine it names is
  in-box. Renumbering warning: pre-2026-08-31 references to "DF1.10 owns the round trip" mean
  **DF1.11**. This story writes no DF1.10 or DF1.11 reference and is not affected by the
  renumbering — verified 2026-09-08.
- Sizing/graph: `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`
  §1.5 (this row, `:89`), §2 (successor map), §5.2, §5.4. **§1.5's row is stale in two ways** and is
  not edited (R5 is a closed research record, INV-3): it reads
  `| DF5.5 | KEEP-repoint chore (dep edges + 2 enum citation fixes + 3 boundary amendments) | 2 |` —
  but the two enum-citation fixes are **NOT-FOUND** (amendment B), there are now five live
  amendment families plus one retired, and the estimate is **3** (see the re-estimate note above).

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
against the successor map, two additive boundary statements, one SwarmClaw role line, one
engine-seam placement note across two files (amendment F), the `sprint-status.yaml` KEEP-row
`deps:` repoints (amendment G), and recorded
dispositions for three instructions that survived into the amendment set but have no work left in
them — the audit's two enum-citation fixes (both verified NOT-FOUND — see amendment B) and the DF2.3
ceiling-chain tightening (verified already-satisfied — see amendment E). Every edit in the 11 amended
files carries the literal marker `v5 amendment (DF5.5)` so the whole change set is one grep away.

## E2E Slice

**Demonstrable behavior:** Given the DF slate frozen — the count is **read from
`sprint-status.yaml`'s meta block at apply time, never hardcoded here** — When the chore is
applied, Then the
**retired-ID grep** over the 12 in-scope files returns **zero lines** — every surviving mention of a
retired ID names its DF successor on the same line — and the **marker grep**, scoped to the two
story directories and sorted, returns exactly the 11-path amended-file list:

```
grep -rl 'v5 amendment (DF5.5)' \
  _bmad-output/sprint-artifacts/phase-0/stories/ \
  _bmad-output/sprint-artifacts/phase-1/stories/ | sort
```

The scoping is load-bearing: the literal `v5 amendment (DF5.5)` also occurs in this story file
(verified 2026-09-13: 12 occurrences here; **zero** in the epics doc — the earlier enumeration that
included it was wrong) and, once this story's dev creates it, in the regression test — so an
unscoped `grep -rl` returns **strictly more than
11** paths and can never equal 11. Every marker this chore writes lands inside those two directories: no amendment edits a
file outside them.

**Wiring closed:** On completion of this story, no KEEP story points a developer at a retired ID or
at an unowned boundary, using only edits merged by this story. No stub, no `TODO: wire later`, and
no sibling story is required. This is a documentation chore: it changes no code and no AC substance.

**Dependency edges (predecessors) — CANONICAL SUCCESSOR SET (cite this, do not restate):**
DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3 — plus **DF1.10** and **DF2.10**, written
as *cited context* rather than as edges (amendment C's `p1-9` blockquote names DF2.10's
`Restart=no` and DF1.10's reclaim; amendment F's blockquote names DF1.10). Both are `done`, and
both are in the set because AC4's precondition is over **IDs the amendments write**, and INV-4 does
not distinguish an edge from a citation — the ADR renumbered DF1.10↔DF1.11 once already, and this
chore runs last. Together these are the successor IDs this chore actually writes into a file
(amendments A, C, D and F; E is retired as already-satisfied and writes nothing;
**DF6.1 is no longer in this set** — `p1-18:50` is handed off, see the P1.18 disposition note).
**DF6.1a is a *scheduling* edge but not a successor-set member** — its wave must annotate
`p1-18:50` before AC1's grep can pass, so `sprint-status.yaml`'s DF5.5 row correctly lists it while
AC4 does not check it. **DF6.1b is neither**: it writes nothing this chore depends on.
AC4 and §Infra Prerequisites cite this list rather than repeating it, so it drifts in one place
only. The chore is scheduled after the whole slate freezes, but a frozen ID that appears in no
amendment is not an edge.

**Re-verification gate (MANDATORY, before the first edit).** This story was authored 2026-08-12;
its successor set names IDs the current review campaign is still editing. **This gate has already
fired once, on 2026-09-08:** DF6.1 was split into **DF6.1a**
(`df6-1a-pr-feedback-bounded-fix-attempt.md`, 4 pt — PR feedback → bounded fix attempt → verified
append) and **DF6.1b** (`df6-1b-fix-loop-verdict-attempt-budget.md`, 3 pt — CI verdict, attempt
budget, escalation), and `df6-1-pr-feedback-fix-loop.md` was **deleted**. Every DF6.1 citation
below has been re-pointed accordingly. **DF5.3** (amendment D's role line) is still
`ready-for-dev` and under re-estimate, so it can move again. Before applying anything, re-run AC4's
precondition over the canonical set above *and* re-read the current filenames under
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/`; if any target has been renamed, split or
renumbered, update the canonical set and the amendment text that cites it, and record the drift in
the amendment log **before** the first edit. A renamed target discovered after the edits is a
dangling pointer (INV-4).

## Acceptance Criteria

1. **(make-or-break)** Given amendments A–E in §Technical Notes, When the chore is applied, Then both
   verification greps pass:
   - **Retired-ID grep** over all 12 in-scope files (11 KEEP + P0.7, phase-0 included):
     `grep -rnE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b' _bmad-output/sprint-artifacts/phase-1/stories/p1-{2,3,5,7,9,11,12,14,18}-*.md _bmad-output/sprint-artifacts/phase-0/stories/p0-{5,7,9}-*.md | grep -v 'DF[0-9]'`
     returns **zero lines**.
   - **Marker grep** scoped to the two story directories (see §E2E Slice), sorted, returns **exactly
     the 11 amended paths** — `p0-5` is absent because it has zero hits and is never opened.
   - **YAML retired-ID grep** (the artifact machines actually read):
     `grep -nE 'deps: \[[^]]*P1\.(1|4|6|8|10|13|15|16|17|19)\b' _bmad-output/sprint-artifacts/sprint-status.yaml`
     returns **zero lines whose story key is a KEEP story** (P1.2, P1.3, P1.5, P1.7, P1.9, P1.11,
     P1.12, P1.14, P1.18). Rows for `superseded` stories keep their retired-ID deps — they are
     historical record (the INV-2 analogue for the yaml).

   The `grep -v 'DF[0-9]'` filter only proves an annotation exists on the line, not that it is the
   *right* successor, so it is backed by a **table-driven per-pair assertion** in
   `tests/scripts/keep-repoints.test.ts`: for each `(file, retired ID, successor ID)` triple in the
   successor map, every surviving line in that file mentioning the retired ID must also mention its
   mapped `DF<x>.<y>` **on the same line**, and a line naming a *different* DF ID MUST fail.
   *Negative control: a find-and-replace that rewrites historical provenance references
   ("shipped PR #40/#87") into DF IDs passes the plain grep but destroys the record and MUST fail
   review — forward-looking references are repointed, provenance references are annotated.*
2. Given amendment C, When P1.9 and P1.5 are read, Then each names the DF story that owns the
   adjacent scope (DF1.3 owns in-phase retry; DF1.5 owns the roster config schema + dual slug
   validation), and neither file's Acceptance Criteria block changes at all. For **these two files
   the zero-character rule holds literally** and is asserted as such: `p1-9`'s only retired-ID hit
   is `:25` (the dependency-edge line, outside every AC) and `p1-5` has none. The four in-block
   edits INV-1 admits are all in *other* files (`p1-3`, `p1-12`) — `p1-11:48` sits in that file's
   `## Technical Notes`, not a governed block (verified 2026-09-08) — see INV-1.
3. Given amendments A and D, When `p0-7-swarmclaw-agent-mcp-hindsight.md` is read, Then it carries the
   one-line DD-7 role statement below its H1 **and** the amendment-A edits at L55 and L136, and no
   P0.7 **AC, DOD item, or shipped asset** is modified — P0.7 stays frozen DONE-KEEP. The two
   amendment-A edits are narrative and illustrative-comment text, not assets: L136 is a
   downstream-contract paragraph whose three forward-looking `P1.1` mentions are repointed to `DF3.1`,
   and L55 is a comment inside an illustrative snippet describing a shipped registration requirement,
   so it keeps `P1.1` and gains the provenance annotation `(now DF3.1)`. No schema name, no
   endpoint and no code line under P0.7 changes.
4. **(failure path)** Given the amendment set, When the chore runs, Then **every successor ID written
   by any amendment** — the **canonical successor set declared in §E2E Slice** (amendments A, C, D
   and F; cited, not restated here) — is confirmed to resolve to an existing file under
   `_bmad-output/sprint-artifacts/dark-factory-v5/stories/` before the first edit; if any does not,
   the chore stops and records the missing ID in the amendment log rather than writing a dangling
   pointer. The precondition is over IDs the amendments actually write, not over the full slate,
   and the slate count is read from `sprint-status.yaml`'s meta block rather than hardcoded.
5. **(boundary)** Given a story with the **RETIRE** disposition (P0.1, P0.4, P0.8, and the RETIRE
   rows of audit §2), When the chore runs, Then that file is not opened for edit — retired stories
   are historical record. This is the disposition recorded for amendment B's only real hit.

## Trigger Surface

| Trigger | Status | E2E Test | Follow-Up |
| --- | --- | --- | --- |
| Developer applies the chore once, by hand, after the slate freezes | in-scope | `tests/scripts/keep-repoints.test.ts` (runs all three verification greps) | — |
| CI regression check on `_bmad-output/sprint-artifacts/**` | in-scope | same test, run in the standard suite | — |
| `sprint-status.yaml` phase-1 KEEP rows (the `deps:` arrays + their `# KEEP per F14; deps repointed by DF5.5 2026-09-08` comments) | **in-scope as a standing check; the edits are ALREADY-APPLIED (2026-09-08) and the file is not opened** | `tests/scripts/keep-repoints.test.ts` (yaml retired-ID scan, AC1 bullet 3) | — |
| Epics index (`_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md`, cited by story key) | out-of-scope — **verified current 2026-09-13**: every slate story carries an entry, DF2.13 included (`grep -c 'DF2\.13'` → 1; positive control `DF2.8` → 16), and the index's DF5.5 make-or-break statement carries amendments A–F and the third grep — the divergence Wave 6 recorded has closed | — | none — the Phase-3 wrap-up item is discharged by the verification above |
| `sprint-status.yaml` DF epic blocks + per-story disposition marks | out-of-scope | — | Phase 3 wrap-up (register §1), not a story |
| Any automated rewrite of story markdown | out-of-scope | — | none — SPL keeps story edits human-authored |

## Infra Prerequisites

| Component | Service (compose/k8s/provider) | Lifecycle Hook Verified |
| --- | --- | --- |
| KEEP story files | git working tree, `_bmad-output/sprint-artifacts/phase-{0,1}/stories/` | files present on branch at apply time (`ls` before edit) |
| DF slate files | git working tree, `.../dark-factory-v5/stories/` | every ID in the **canonical successor set** (§E2E Slice — cited, not restated) resolves to a file on disk, re-verified against current filenames per the re-verification gate — AC4's precondition check |
| `sprint-status.yaml` | git working tree, `_bmad-output/sprint-artifacts/` | present on branch; the eight phase-1 KEEP rows carrying `deps repointed by DF5.5 2026-09-08` are located before edit |
| Verification greps | `tests/scripts/keep-repoints.test.ts` (plain `bun test`; the existing home for repo-hygiene checks alongside `license-sweep.test.ts` and `roster-check.test.ts` — **not** a new `tests/backlog/` tree) | **Four assertions**, all resolving the repo root from `import.meta.dir` and **never** from `process.cwd()` (`bun test` does not guarantee CWD): (1) **retired-ID occurrence scan (count-based, never line-membership)** — for each of the 12 in-scope story files, `grep -oE` the retired-ID pattern and assert the **count of surviving forward-looking occurrences is zero**, and that each surviving **provenance** occurrence (the three enumerated: `p0-7:55`, `p0-9:218`, `p1-3:142`) is followed by its `(now DF<n>.<m>)` annotation within 20 characters on the same line. A line-scoped check passes a line carrying one repointed and four surviving IDs — `p1-3` has 19 occurrences on 8 lines, so that is the likeliest failure — and this assertion MUST fail it. **Every zero-match assertion carries a positive control on the same file** (one pattern that MUST match, e.g. the file's own H1): a grep returning zero matches is indistinguishable from a grep against a file the tool declines to read, so "no hits" only means "clean" once the file is proven greppable — see the note below this table; (2) **per-pair correctness** — table-driven over the successor map, so a line annotated with a DF ID that is *not* the mapped successor for that retired ID **MUST fail** (the plain `grep -v 'DF[0-9]'` passes it); (3) **marker set** — the directory-scoped `grep -rl`, sorted, deep-equals the 11-path literal array (`p0-5` absent), **and `sprint-status.yaml` carries no marker** (amendment G's edits are markerless; the 11-count depends on it); (4) **yaml scan** — zero retired IDs inside any KEEP-story row's `deps:` array in `sprint-status.yaml`. Non-zero exit on any. Per CLAUDE.md the run is captured to a log file, not scrolled. |

No deployed component: this story ships markdown only.

> **A grep that returns nothing has two meanings, and this chore's entire acceptance signal is
> greps.** "Zero matches" and "the tool never read the file" are the same output. A single raw
> control byte makes a text file classify as binary, after which `grep` silently reports no
> matches for *every* pattern — observed 2026-09-08 in `scripts/lib/run-lock.ts` (two raw NULs;
> `grep -c` exited 1 while `sed` printed the symbol; **no longer reproduces** — the DF2.11/DF2.13
> rounds rewrote the file and a byte scan now finds zero NULs. The guard stays mandatory: it is the
> durable control, and this note is evidence history, not a live defect). So **every zero-match assertion in this story
> pairs with a positive control on the same file**: one pattern that MUST match (the file's H1 is
> the cheapest). If the control fails, the file is unreadable, and the assertion reports
> *unproven*, never *clean*. This is the durable guard; fixing any one file's bytes is not.

## Technical Notes

- **Successor map (binding; source R5 §2 + audit §2):** P1.1→DF3.1 · P1.4→DF1.1 · P1.6→DF1.6 ·
  P1.8→DF1.8 · P1.10→DF3.4 · P1.13→DF2.8 · P1.15→DF5.2 · P1.16→DF5.3 · P1.17→DF5.4 ·
  **P1.19→DF6.1a** (P1.19 RE-DERIVE split 2026-09-08 across DF6.1a *and* DF6.1b; the fix-dispatch
  half — DF6.1a — is the successor for every P1.19 occurrence in the KEEP corpus, and the only one
  is `p1-18:50`, which this chore hands off).
  P1.4/P1.10/P1.16/P1.17 appear in **no** KEEP story; their rows exist for the epics index.
- **Amendment A — dependency-edge repoints.** Occurrence lines verified 2026-08-11 by
  `grep -onE 'P1\.(1|4|6|8|10|13|15|16|17|19)\b'`; re-verify before editing and record drift.

  | KEEP file (`phase-1/stories/` unless marked) | Lines | Repoint |
  |---|---|---|
  | `p1-2-qds-intake-issue.md` | 26 | P1.1 → DF3.1 — **replacement text, not substitution** (the line's gloss is false after a bare swap); see the gloss rule below |
  | `p1-3-seeds-decompose-mirror.md` | 22 (×3), 24 (×5), 39, 46, 138 (×3), 142, 147 (×3), 154 (×2), 155 | **19 `P1.1` occurrences across 8 lines** — **per occurrence, not per line** (verified 2026-09-08: `grep -oE 'P1\.1\b' \| wc -l` → 19). **18 repointed** → DF3.1; **`:142` (×1) is PROVENANCE** — keeps `P1.1`, gains `(now DF3.1)`, see below. P1.6 → DF1.6 (L46, ×1). Precede with the `p1-3` header blockquote below. L39/L154/L155 are in-block edits (INV-1) |
  | `p1-7-lsp-diagnostics-gate.md` | 26 | P1.6 → DF1.6 |
  | `p1-9-restart-policy.md` | 25 | P1.8 → DF1.8 — **but see the `p1-9` edge-divergence note below; resolve before applying** |
  | `p1-11-hindsight-prime-retain.md` | 25, 48, 51 | P1.6 → DF1.6 (25, 51); P1.1 → DF3.1 (48, in-block per INV-1). **At :51 the path is also amended** — `src/protocol/phase-executor.ts` is pre-v5; see amendment F |
  | `p1-12-mulch-prime-record.md` | 25, 31, 39 | P1.6 → DF1.6 (31 is in-block per INV-1). **At :39 the path is also amended**, same substitution and note; see amendment F |
  | `p1-14-outcome-record-router.md` | 24, 26 | P1.13 → DF2.8 |
  | `p1-18-pr-comment-polling.md` | 17, 23, 25 (**not 50**) | L25 (dependency edge): P1.15 → DF5.2. L17, L23: repoint **under the shared P1.18 blockquote below**, never bare — the surrounding webhook premise is dead. **L50 (`P1.19`) is handed off to DF6.1a's fix wave** — see the P1.18 disposition note |
  | `p0-9-hindsight-banks-mulch.md` (**`phase-0/`**) | 198, 218 | 198: P1.6 → DF1.6 (mulch-priming consumer contract — forward-looking, repointed). 218: `P1.1` **kept**, annotated `(now DF3.1)` — a shipped JSON-RPC error-code range allocation (`-32010..-32013`) in P0.9's merged bridge, so the **provenance** rule applies, same treatment as `p0-7:55` |
  | `p0-7-swarmclaw-agent-mcp-hindsight.md` (**`phase-0/`**, DONE-KEEP) | 55, 136 (×3) | L136: all three `P1.1` → DF3.1 (downstream-contract-stability paragraph — forward-looking); L55: `P1.1` **kept**, annotated `(now DF3.1)` — a comment in an illustrative snippet describing a shipped registration requirement, so provenance rule applies |

  The rows above are the complete occurrence set for the 12 in-scope files. `p0-5` has zero hits and
  is not opened; `p0-9` and `p0-7` are the two phase-0 files carrying retired IDs. Rule:
  **forward-looking** references (dependency edges, integration points, downstream
  consumers) are repointed. **Provenance** references (a shipped PR, a merged asset, a shipped
  requirement quoted in a snippet) keep the old ID and gain a `(now DF{n}.{m})` annotation — the old
  ID is what the git history says. The P1.19 → DF6.1 repoint at `p1-18:50` was formerly tagged
  "amendment E"; it is **no longer this story's edit at all** (handed off — see the P1.18
  disposition note). The letter E is not vacant — it names the DF2.3 ceiling-chain instruction
  below, retired as already-satisfied.

  **Gloss rule (applies to every repointed line, not just `p1-2`).** A bare ID substitution keeps
  the old ID's descriptive gloss and makes it a lie about the new one. `p1-2:26` reads
  `**Dependency edges (predecessors):** P1.1 (Dev Manager registered as A2A agent).` — swapping the
  ID alone yields "DF3.1 (Dev Manager registered as A2A agent)", but DF3.1 is *Fleet Dispatcher
  Core Verbs* and ships no A2A registration; that mechanism died with P1.1's premise (audit §2).
  **Before applying any substitution, check the line for a parenthetical or appositive gloss; if it
  has one, write replacement text and record before/after in the amendment log.** For `p1-2:26`:

  > `**Dependency edges (predecessors):** DF3.1 (fleet dispatcher core verbs — the v5 factory front door; was P1.1 "Dev Manager registered as A2A agent", whose A2A front-door premise died with the SwarmClaw protocol engine, audit §2). <!-- v5 amendment (DF5.5) -->`

  **`p1-3` header blockquote (insert below the H1 *before* the 19 substitutions).** All 19 `P1.1`
  mentions in `p1-3` describe `/api/a2a`, `a2a.delegate(...)` and P1.1's Transport Contract;
  `p1-3:22` itself says the route "does not exist in source today". Bare swaps would assert DF3.1
  provides that surface. **Eight is the line count, not the mention count** — a developer who
  substitutes once per line leaves eleven live `P1.1` references, and every line-scoped check
  (AC1's grep and test assertions 1 and 2) passes anyway. Insert once, then substitute
  per occurrence:

  > **v5 amendment (DF5.5):** every P1.1 reference below is repointed to **DF3.1** (fleet dispatcher
  > core verbs), P1.1's F14 successor. DF3.1 does **not** ship P1.1's `/api/a2a` route or
  > `a2a.delegate` transport — that SwarmClaw-protocol-engine premise is dead (audit §2, DD-7). The
  > v5 front door is the tier-1 CLI. This story's decompose invocation re-derives onto DF3.1's
  > dispatch surface when P1.3 is scheduled; the A2A mechanics below are historical.

  **The substitutions are not bare** — the gloss rule above applies to every one of them, and
  `p1-3`'s glosses are heavier than `p1-2:26`'s. **The one verbatim quoted gloss is "the A2A
  delegation layer (P1.1)" (`p1-3:24`); three further phrasings an earlier draft of this note
  carried ("P1.1's registration schema", "the local-only Transport Contract enforced by P1.1
  INV-4", "P1.1's envelope helper") appear nowhere in p1-3 and are retracted** — write each line's
  replacement text from the line's own words (checking for a parenthetical or appositive gloss),
  never from an inventory. The blockquote fixes the *reading*; it does not fix the *text*. First
  occurrence per line becomes `DF3.1 (was P1.1's <gloss>; that A2A surface is historical — see the
  amendment above)`, bare `DF3.1` thereafter. Record before/after for all 18 in the amendment log.

  **`p1-3:142` is a PROVENANCE line, not a repoint.** It records the same JSON-RPC range allocation
  `p0-9:218` records — "A2A-level errors (`-32010` through `-32013`) from P1.1 may propagate" vs
  p0-9's "The P0.9 range is distinct from P1.1 (`-32010..-32013`)". One fact, so one treatment: it
  keeps `P1.1` and gains `(now DF3.1)`, identical to `p0-9:218`. Substituting it would erase the
  record of which *story* owns that range. (Its "may propagate" premise rests on the dead
  `/api/a2a` surface, which the header blockquote above already covers — no second annotation.)

  **P1.18 disposition (2026-09-08 correction — one edge handed off).** P1.18 is KEEP but
  **UNSCHEDULED**: outside the v5 window and not counted in the DF slate totals (the P1.18 row in
  `sprint-status.yaml`, cited by story key, records the UNSCHEDULED disposition and the
  two-half denial). Its mechanism — a SwarmClaw webhook receiver at
  `/api/webhooks/[id]` with HMAC signature validation — is out of scope for v5.0 per DD-1 and
  DF6.1b's AC1 webhook exclusion (that story's AC1, closing note: "Inbound webhooks … are **out of scope for v5.0**"), so
  repointing `:17`/`:23` bare would produce an apparently-current v5 contract describing
  ingress the slate has refused to build. Insert this blockquote below the H1 first, then repoint
  `:25` and annotate `:17`/`:23` beneath it:

  > **v5 amendment (DF5.5):** P1.18 is KEEP but **UNSCHEDULED** for v5.0. The PR its polling watches
  > is now produced by **DF5.2** (host-side PR creation). v5.0 has **no webhook ingress** (DD-1
  > makes the operator the channel), so the receiver described below is not a v5 surface — the
  > references are annotated for provenance, not revived as a contract.

  **`:50` (`P1.19` → **DF6.1a**) is NOT applied by this chore.** *(DF6.1 was split 2026-09-08;
  `df6-1-pr-feedback-fix-loop.md` is deleted and its old line citations are void.)* **Both** halves
  state that **P1.18 is not a predecessor**, each for a *different* reason — both severances are
  load-bearing, neither half is redundant. Citations are given as **search anchors first, line
  numbers second**, because the line numbers have already drifted once (see the re-verification
  gate): DF6.1a — search `P1.18 is not a predecessor` → *"**the *comment-read* limb.** Its webhook
  receiver is out of scope for v5.0"* (`df6-1a-pr-feedback-bounded-fix-attempt.md`, search anchor
  only — its line numbers are void, the anchors are binding); DF6.1b — same anchor → *"**the
  *verdict* limb** … the verdict is **polled**, and a
  poll needs no receiver"* (`df6-1b-fix-loop-verdict-attempt-budget.md`, same search-anchor rule),
  plus the webhook
  exclusion (search `out of scope for v5.0` in `df6-1b-fix-loop-verdict-attempt-budget.md`) and the Trigger Surface row (search
  `Inbound webhooks`, same file).
  `sprint-status.yaml`'s P1.18 row (cited by story key) agrees: *"DF6.1a/DF6.1b do not depend on it, and each
  denies it for a DIFFERENT reason … DF6.1a denies the receiver as an INTAKE channel …, DF6.1b
  denies it as a VERDICT channel"*. **Note that row's own 2026-09-08 correction:** its earlier
  "v5.0 polls `gh pr checks`" wording is **retracted as wrong** — DF6.1b specifies a two-call
  composition (`gh pr view --json statusCheckRollup` for SHA binding + `gh pr checks --required`
  for requiredness) — which does not disturb the severance. Do not re-quote the retracted string.
  Writing a webhook-fed edge at `p1-18:50` would send a developer to build the
  receiver for a consumer that reads the API directly. **Register DD-2's "P1.18 (KEEP) repoints to
  DF6.1" (`register:47`) is the stale source, superseded by both halves' shipped text under the
  drift rule.** Ownership: **DF6.1a's fix wave owns this annotation.** `p1-18:50` reads "preserving
  sufficient context for **downstream fix dispatch** (P1.19)" — that is the fix attempt, and
  **DF6.1a is the half that consumes P1.18's payload shape**: search `botComments[]` →
  "a `botComments[]` payload (the shape P1.18 defines, `p1-18-pr-comment-polling.md:36`, **without
  its receiver**)" (`df6-1a:55`, verified 2026-09-08). `p1-18:36` verified first-hand, not taken
  from DF6.1a: it is P1.18's Contracts/Schema line and does carry the shape —
  `botComments: [{ commentId, author, bodySnippet, timestamp }]` — alongside the webhook bot-detection
  contract DF6.1a does *not* take. DF6.1b's severance concerns the CI *verdict
  poll*, which `p1-18:50` is not about. DF5.5 records the hand-off in its amendment log, and its
  DoD asserts the line **is** annotated — not that DF5.5 annotated it.

  **Fallback — and it must be executable, not decorative.** DF5.5 is only *scheduled* last; nothing
  gates it on DF6.1a's merge. `p1-18:50` sits inside `p1-18`'s `## Security Invariants` block
  (`p1-18` headers: `47:## Security Invariants`, `53:## Definition of Done`) and is covered by
  AC1's retired-ID scan. A fallback that adds text **below the H1** does not touch `:50`, so `:50`
  still carries an unannotated `P1.19`, AC1 returns one line, and test assertions (1) and (2) fail
  — while the only edit that *would* pass is an in-block hunk INV-1 would reject. Both branches
  dead-end. So the fallback is **pre-authorised here as an admitted in-block edit**: *if DF6.1a's
  wave declines the annotation **or has not landed at apply time**,* DF5.5 annotates `:50` itself —

  > `…while preserving sufficient context for downstream fix dispatch (P1.19 — now **DF6.1a**, which consumes this comment payload shape but **not** this story's receiver). <!-- v5 amendment (DF5.5) -->`

  — and records in the amendment log which path was taken. This is an identifier annotation drawn
  verbatim from the successor map, the one class INV-1 permits inside a governed block; it is
  admitted **by name** so INV-1's tripwire counts from five, not four, on the fallback path only.
  The **DD-2 register addendum** is likewise **not** DF5.5's:
  it is a decision change, so per INV-3 it goes to the campaign's register-amendment output, never
  resolved by editing prose here — **and DD-2a is already landed** (`register:48`, ACCEPTED
  2026-09-08: records the DF6.1 split, the dangling ID, and the `p1-18:50` assignment to DF6.1a's
  wave), so no register edit is owed. Verified 2026-09-08.

  **`p1-9` edge divergence (RESOLVED and applied 2026-09-08; DF5.5's remaining obligation is the
  `p1-9:25` edit only).** `p1-9:25` names `P1.8`; the yaml's `P1.9` row (cited by story key) named
  `deps: [P1.6]` and carried an unresolved 2026-07-28 note asking whether P1.8 belongs back in
  deps. The two artifacts disagreed about which predecessor P1.9 has, so a mechanical one-sided
  repoint would have hardened the disagreement rather than cleared it.
  **Disposition — applied:** both sides were repointed to the union of their mapped successors.
  `p1-9:25` becomes
  `**Dependency edges (predecessors):** DF1.6 (was P1.6, per sprint-status), DF1.8 (was P1.8, per this file). <!-- v5 amendment (DF5.5) -->`
  and the yaml row **already reads** `deps: [DF1.6, DF1.8]` (amendment G, applied 2026-09-08).
  Both DF1.6 and DF1.8 are `done`, so
  the union blocks nothing and is strictly safer than picking a side; it is a dependency-edge
  repoint, which the KEEP amendment allowance covers (audit `:24`). Record divergence and
  resolution in the amendment log.
- **Amendment B — the two enum-citation fixes are NOT-FOUND; record, do not invent.** Audit §2
  rows 92/95 instruct fixing a stale 4-value enum citation at `_bmad-output/sprint-artifacts/phase-1/stories/p1-11-hindsight-prime-retain.md:44`
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
  - `p1-9-restart-policy.md`: P1.9 owns **cross-run** restart classification — its own three-value
    `FailureClass` (`transient | overflow | logic`, `p1-9:36`), which is the *failure subset* of the
    CC-1 five-value `exitStatus` enum (`success | transient | overflow | logic | lead_failure`,
    `p0-3-mixed-model-demo.md:126`); the classification input is a `FailureSignal`, not an
    `exitStatus` literal, and this amendment changes neither. **In-phase** retry — JSON-parse and
    gate-violation retries re-entering the same agent session — is **DF1.3's**, separately bounded.
    In-box process supervision is neither: DF2.10 ships `qds-run@.service` with **`Restart=no`**
    (`df2-10:106,173`) and DF1.10 owns reclaim semantics (`df1-10:91,143`), so a crashed in-box
    engine is **not** restarted by systemd and is not P1.9's cross-run classification either.
  - `p1-5-model-router-hindsight.md`: P1.5 owns **router scoring against outcome records** (step
    6). The roster **config schema and dual slug validation** (pi's bundled catalog AND the
    provider API, plus `~/.pi/agent/models.json`) is **DF1.5's**.
- **Amendment D — DD-7 SwarmClaw role line.** One blockquote below the H1 of
  `p0-7-swarmclaw-agent-mcp-hindsight.md`: *SwarmClaw's v5 role is the host-side service chassis
  for factory query surfaces — the natural HTTP home for DF5.3's audit-chain query if it ever needs
  one (DF2.8 shipped its cost view as a CLI surface, `qds cost`, 2026-08-21). It is **not** the
  factory front door; that is the tier-1 CLI
  (DD-1/DD-7). P0.7 assets stay frozen; no AC changes.*
- **Amendment E — the DF2.3 ceiling-chain tightening is ALREADY-SATISFIED; record, do not rewrite.**
  E formerly instructed a single-line wording amendment to `dark-factory-v5/stories/df2-3-*.md`,
  tightening a non-strict chain (`run-key cap ≥ DF2.8 budget cap ≥ DF3.6 per-run ceiling`) so the
  budget ↔ resident pair reads strict. Verified 2026-08-12: **`df2-3` already carried DF3.6's strict
  chain verbatim** — `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`, with
  DF3.6's `loadResidentBounds` named in the same paragraph as its single owner — put there by an
  earlier fix in this review campaign, before this chore was ever scheduled. **Re-verified
  2026-09-13, superseding that quoted evidence:** df2-3's live chain is now the operator-corrected
  `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per run) ≤ defaultKeyCapMicroUsd` (the
  DF2.13/DF3.6a correction, credited in df2-3's own correction blockquote); the old strict-`<`
  chain survives only as quoted history inside that blockquote, and `loadResidentBounds` occurs
  **zero** times in df2-3 (the symbol lives in df3-6a and a corrected `credentials.ts` docstring).
  E's disposition is unchanged — retired, `df2-3` unopened — and the re-verification sharpens why:
  re-applying E against today's text would rewrite the operator-corrected `≤` chain back to a
  strict `<`, the exact regression E's retirement exists to prevent. There is nothing left to
  amend. **The chains are quoted here as evidence of what `df2-3` carries — not asserted by
  this chore as a settled invariant, and not written into any file.** Its middle term
  (`runBudgetCapMicros`) was **unenforced** — `scripts/cap-hit-demo.ts` declares it "Inner
  control: run budget cap (artifact field only)" beside the `runBudgetCapMicros` field (line
  numbers per the deviation rule below — they moved in DF2.13's round-1 patch), a CLI flag recorded into DF2.4's evidence JSON.
  **Operator ruling 2026-09-08: re-home the term, do not invent a control.** The corrected chain is
  `residentSpendCeilingMicros ≤ capMicroUsd (mint-time, per run) ≤ defaultKeyCapMicroUsd` — note
  the strict `<` becomes `≤`. `mintRunKey` already takes `deps.capMicroUsd ?? defaultKeyCapMicroUsd`
  (cited by symbol; the docstring in `src/providers/credentials.ts` records the line numbers that
  chased this exact expression and lost); the enforcement point existed and was never wired, and
  **DF2.13** ("Per-Run Key Cap Wired from the Admission Budget", ~3 pt, v5-S3) wires it from DF2.8's
  remaining issue budget. **DF5.5 neither repoints nor rewrites the chain** — amendment E's
  disposition is unchanged: E stays retired and `df2-3` stays unopened. Disposition (same shape as amendment B): record the verification and its command in the
  amendment log; **`df2-3` is not opened for edit**, DF3.6 is not an edge of this chore, and no
  successor-ID precondition is run for it. This is why the chore edits nothing outside
  `phase-{0,1}/stories/` and why every marker it writes lands in the 11-path count.
- **Amendment F — engine-seam path + placement note (ADR-derived, additive).** `p1-11:51` and
  `p1-12:39` both name `src/protocol/phase-executor.ts` as the prime/retain hook seam and gloss it
  as a P1.6 artifact. That path is pre-v5: register §1 (`:23`) puts new engine code under
  `src/phase-engine/*`, `src/protocol/phase-executor.ts` does not exist, and no DF story creates
  it. Since the ACCEPTED 2026-08-31 tier-2 placement ADR the engine additionally runs **in-box**
  (DF1.10, done 2026-09-06) — so the seam is not merely at a different path, it is on a different
  machine. A `P1.6` → `DF1.6` swap alone leaves a live DF ID sitting next to a dead path, which
  reads as authoritative and invites a developer to create the file (the exact
  `src/memory/hindsight-client.ts` duplication the same line's REUSE clause forbids). Insert one
  blockquote below the H1 of **each** file, alongside the amendment-A ID repoints:

  > **v5 amendment (DF5.5):** the prime/retain hook seam named below as
  > `src/protocol/phase-executor.ts` is pre-v5. The v5 phase engine lives under
  > `src/phase-engine/*` (derivation register §1) and, per the 2026-08-31 tier-2 placement ADR,
  > **runs inside the sandbox box** (DF1.10). Wire prime/retain against the in-box engine's phase
  > lifecycle, not a host-side executor. The M-PairB-1 edit-ordering note (P1.11 lands first,
  > P1.12 extends its hook) is unchanged.

  This is a pointer amendment, not an AC change: neither file's AC block is touched by it, and
  both files are already in the 11-path marker set, so the marker count does not move.
- **Amendment G — `sprint-status.yaml` KEEP-row `deps:` repoints — ALREADY-APPLIED 2026-09-08. Do
  not re-apply; the yaml is not opened for edit.** This chore specified the repoints and the parent
  applied them the same day. **Re-verified 2026-09-08** against the tree — all fourteen changes are
  in place (fourteen = the **six** `deps:` arrays this amendment wrote, plus the **eight**
  discharged comments; P1.18's seventh array was applied by another hand and is verified but not
  counted as this amendment's write), at these (corrected) lines:

  | Row (`sprint-status.yaml`, cited by story key — never by line; see the note below) | `deps:` now | Was |
  |---|---|---|
  | `P1.2` | `[DF3.1]` ✅ | `[P1.1]` |
  | `P1.7` | `[P0.6, DF1.6]` ✅ | `[P0.6, P1.6]` — P0.6 is DONE-KEEP, untouched |
  | `P1.9` | `[DF1.6, DF1.8]` ✅ | `[P1.6]` — the union, per the `p1-9` divergence note |
  | `P1.11` | `[P0.9, DF1.6]` ✅ | `[P0.9, P1.6]` |
  | `P1.12` | `[P0.9, DF1.6]` ✅ | `[P0.9, P1.6]` |
  | `P1.14` | `[P1.5, DF2.8]` ✅ | `[P1.5, P1.13]` — P1.5 is KEEP, untouched |
  | `P1.18` | `[DF5.2]` ✅ | applied by another hand before this chore was specified |

  `P1.3` (`[P1.2, P0.9]`) and `P1.5` (`[P0.9, P0.10]`) carry the comment but **no
  retired ID** — their arrays were already correct and were never rewritten. All eight commented
  rows now read `# KEEP per F14; deps repointed by DF5.5 2026-09-08`, and P1.9's open 2026-07-28
  question ("re-evaluate whether P1.8 belongs back in deps") is discharged with the prescribed
  clause `P1.8 question resolved by DF5.5: both edges retained as DF1.6 + DF1.8`. Rows for
  `superseded` stories keep their retired-ID deps — historical record, the INV-2 analogue.

  **Disposition — same shape as amendments B and E:** record the verification command and its
  output in the amendment log; `sprint-status.yaml` **appears in no hunk of the diff**. AC1's third
  grep is now a **standing regression check**, not a work item. *(Note the earlier line citations
  `:92-105` in this story were off by ~18 lines — the yaml grew. Cite by **story key**, not by
  line: a developer following a stale line number lands on a P0 row and may "repoint" `[DF3.1]` to
  `[DF3.1]` or double-write the P1.9 clause.)*
- **Slate sweep — three explicit negatives (checked, nothing to add).** (1) **No new repoint
  targets from the ADR.** None of the six retired IDs appearing in the 12 in-scope files (P1.1,
  P1.6, P1.8, P1.13, P1.15, P1.19) has a successor the 2026-08-31 ADR moved: DF3.1, DF1.6, DF1.8,
  DF2.8 and DF5.2 are all unchanged by it, and P1.19's successor moved only by the 2026-09-08
  DF6.1 split (handled above). The ADR arc invalidated **zero** successor-map rows. (2) **Nothing
  for DF3.6 (split 2026-09-08 into DF3.6a/DF3.6b).** Amendment E stays retired and the DF3.6
  re-sequence changes no
  KEEP-story text — verified: no KEEP story mentions DF3.6 or the ceiling chain. (3) **Nothing
  from DF2.11 / DF2.12 / DF2.13.** The stories added 2026-09-08 (teardown run-lock + read-only cost
  ledger; per-role token cost attribution; per-run key cap) introduce **no** KEEP-story edit: none is the
  successor of any retired ID, and no KEEP story references any of them — DF2.13 included, verified
  2026-09-13. All
  three negatives are recorded here so a reader does not have to re-derive them.
- **Amendment C erratum (recorded, DD-8 class).** Audit §2's P1.9 row and register §4 both describe
  P1.9's policy as "keyed on the exitStatus enum". Verified 2026-09-08: `exitStatus` occurs **zero**
  times in `p1-9-restart-policy.md`; the story's Overview (`:17`) says three categories, AC1
  (`:29`) says `transient | overflow | logic`, and its contract (`:36`) pins a three-value
  `FailureClass` over a `FailureSignal`, while CC-1's enum is five-valued. Left uncorrected, the
  blockquote would land three lines above P1.9's untouched AC1 asserting a five-value key against a
  three-value AC — inviting a developer either to widen `FailureClass` (an AC-substance change
  INV-1 forbids) or to implement a five-value classifier the ACs will fail. The blockquote text is
  corrected **here**, not in the closed audit or the register (INV-3); the amendment log records the
  command
  (`grep -c 'exitStatus' _bmad-output/sprint-artifacts/phase-1/stories/p1-9-restart-policy.md` → `0`).
  This is the **third** DD-8-class label drift in this chore's inputs, after amendment B's two.
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

- `phase-1/stories/p1-{2,3,7,14}-*.md` — amendment A
- `phase-1/stories/p1-18-pr-comment-polling.md` — amendment A (L25 repoint; L17/L23 annotated under
  the P1.18 blockquote). **L50 is not edited by this story** — handed to **DF6.1a**'s fix wave
- `phase-1/stories/p1-{11,12}-*.md` — amendments A + F (ID repoint **and** engine-seam path note)
- `phase-0/stories/p0-9-hindsight-banks-mulch.md` — amendment A (L198 repointed, L218 annotated)
- `phase-1/stories/p1-9-restart-policy.md` — amendments A + C
- `phase-1/stories/p1-5-model-router-hindsight.md` — amendment C
- `phase-0/stories/p0-7-swarmclaw-agent-mcp-hindsight.md` — amendments A (L55, L136) + D
- `dark-factory-v5/stories/df5-5-keep-repoint-chore.md` — amendment log

**`_bmad-output/sprint-artifacts/sprint-status.yaml` is verified, NOT modified** — amendment G is
already applied (2026-09-08). It must appear in **no hunk** of this story's diff. It carries no
`v5 amendment (DF5.5)` marker, so the 11-path marker count is unaffected either way.

`phase-0/stories/p0-5-pi-lens-headless-tdi.md` is in the verification-grep scope and **not** in this
list: zero hits, never opened.

- `tests/scripts/keep-repoints.test.ts` — the four-assertion regression test (§Infra Prerequisites)

## Security Invariants

- INV-1: **Edit scope is bounded to non-normative _substance_.** No `## Acceptance Criteria`,
  `## Definition of Done`, or `## Security Invariants` line in **any file this chore edits** may
  change in **substance** — the eleven amended files, ten KEEP plus
  `p0-7-swarmclaw-agent-mcp-hindsight.md`'s DONE-KEEP. The audit's amendment allowance (audit
  `:24`) covers dependency edges and single-line factual statements only. **The one permitted class
  of change inside those blocks is a successor-ID substitution or provenance annotation drawn
  verbatim from the successor map — an identifier swap, nothing else.** Enforced by reviewing the
  diff per file: an AC/DOD/INV hunk whose before/after differ by anything other than a mapped
  `P1.x` → `DF<n>.<m>` substitution (or the addition of `(now DF<n>.<m>)`) is a rejection.
  *(Why this is stated in substance terms: amendment A's occurrence table orders edits to five
  lines, **four of which sit inside those blocks** — `p1-11:48` sits in that file's
  `## Technical Notes`, not a governed block, and is counted separately below — so a line-touch
  reading would make INV-1 and AC1 mutually
  unsatisfiable — apply them and review rejects, skip them and AC1's grep fails. The audit permits
  the swap; it forbids the substance change.)* The **four** known in-block edits are **`p1-3:39`**
  (AC4), **`p1-3:154`** and **`p1-3:155`** (DoD), and **`p1-12:31`** (AC3). *(`p1-11:48` sits in
  that file's `## Technical Notes` — `p1-11` headers: `27:## Acceptance Criteria`,
  `37:## Technical Notes`, `55:## Files to Modify` — so it merely *discusses* AC1/INV-MEM-2 and is
  not a governed-block edit; counted separately, verified 2026-09-08.)* **Any fifth in-block hunk
  is a rejection on sight** — except the one pre-authorised fallback at `p1-18:50` (see the P1.18
  disposition), which makes the tripwire read *sixth* on that path only, and only when the
  amendment log records that the fallback was taken.
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

- [ ] **Pre-flight:** The re-verification gate (§E2E Slice) is run **before the first edit** —
      the canonical successor set re-checked against current filenames and any drift recorded in
      the amendment log. The gate already fired once (DF6.1 → DF6.1a/DF6.1b, 2026-09-08, absorbed);
      DF5.3 is still unbuilt and can move again.
- [ ] **Impl:** Amendment A applied across the ten files in the occurrence table (P0.9 and P0.7
      included), forward-looking references repointed and provenance references annotated, with
      **replacement text for every gloss-bearing line** (gloss rule) and the `p1-3` and `p1-18`
      header blockquotes inserted **before** their substitutions.
- [ ] **Impl:** Amendment C's two boundary blockquotes inserted in P1.9 and P1.5 — P1.9's uses the
      **corrected** three-value `FailureClass` text, not the "keyed on the exitStatus enum" wording.
- [ ] **Impl:** Amendment D's SwarmClaw role line inserted in P0.7.
- [ ] **Impl:** Amendment F's engine-seam blockquote inserted in P1.11 and P1.12.
- [ ] **Verify (not impl):** Amendment G re-verified **ALREADY-APPLIED** — the seven `deps:` arrays
      and all eight discharged comments confirmed present by story key, the command and its output
      recorded in the amendment log, and `sprint-status.yaml` **absent from every hunk of the
      diff**. (The old "amendment G applied" item was unfalsifiable: it was already true before the
      story started.)
- [ ] **Verify (not impl — the slate count is recomputed, never trusted):** at apply time, recompute
      the slate from the per-story rows (stories, points, done, not-done — per-epic included) and
      assert the meta block equals the recompute; record **both** numbers and the command in the
      amendment log. **No count is hardcoded in this story or its log as an assertion input** — the
      meta block has been wrong before (it lagged the DF2.13 row by a whole story), and a chore that
      reads its count from a stale block records a number its own source contradicts. A mismatch
      stops the chore: fix the meta block first (parent-owned, outside this story's diff), then
      re-run.
- [ ] **Hand-off:** `p1-18:50` (`P1.19`) is confirmed **annotated by DF6.1a's fix wave** — this
      story asserts the line is annotated, not that it annotated it. The hand-off and the DD-2
      supersession are recorded in the amendment log; the DD-2 register addendum is routed to the
      campaign's register-amendment output, not resolved here (INV-3).
- [ ] **Contract:** Every edit carries the literal marker `v5 amendment (DF5.5)`; the
      directory-scoped `grep -rl … | sort` returns exactly the 11 amended paths and nothing else.
- [ ] **Integration:** Amendment B's two NOT-FOUND records, the corpus-wide sweep result, and
      amendment E's already-satisfied verification are in the amendment log with the commands that
      produced them; `df2-3` appears in no hunk of the diff.
- [ ] **Security:** Diff review confirms zero AC/DOD/Security-Invariant **substance** changes in
      **any file this chore edits** — the 11 amended files — and zero edits to any RETIRE'd file
      (INV-1, INV-2). The **four** admitted in-block edits (`p1-3:39`, `:154`, `:155`,
      `p1-12:31`) are listed in the amendment log with their before/after text, and each is
      confirmed an identifier-only substitution **reviewed line by line, not by hunk count**; a
      fifth in-block hunk is a rejection, **except** the pre-authorised `p1-18:50` fallback, which
      is admitted only when the log records that DF6.1a's wave did not land it. (`p1-11:48` is in
      that file's Technical Notes, not a governed block — logged separately.)
- [ ] **Test (regression, all four assertions):** `tests/scripts/keep-repoints.test.ts` runs under
      plain `bun test` (never excluded from a gate) and asserts, resolving the repo root from
      `import.meta.dir` and never `process.cwd()`: (1) a **count-based** retired-ID occurrence scan
      across the 12 story files — zero surviving forward-looking occurrences, each provenance
      occurrence annotated within 20 chars on its line; **never a line-membership check**, which
      `p1-3`'s 19-occurrences-on-8-lines would defeat; (2) table-driven per-pair correctness — a retired ID
      annotated with the **wrong** DF successor MUST fail, which the plain `grep -v 'DF[0-9]'`
      would pass (AC1); (3) the sorted 11-path marker set deep-equals the literal array **and
      `sprint-status.yaml` carries no `v5 amendment (DF5.5)` marker** — the count holds only
      because amendment G's yaml edits are markerless, so assert that negative rather than
      assume it;
      (4) **zero retired IDs in any KEEP row's `deps:` in `sprint-status.yaml`**.
- [ ] **Test (missing successor):** A synthetic map entry pointing at a nonexistent `DF9.9` story
      file → the chore halts and logs, and writes no reference (AC4).
- [ ] **Test (negative control — provenance):** a fixture line rewriting a shipped-PR reference
      ("shipped PR #40/#87") into a DF ID **passes assertion (1) and MUST fail assertion (2)'s
      provenance arm** — forward-looking references are repointed, provenance references are
      annotated. Without this fixture the per-pair assertion is untested against the one rewrite
      that looks correct to every grep.
- [ ] **Test (e2e demo — MANDATORY):** Run all three verification greps on a clean checkout after
      the chore lands → zero unannotated retired IDs across all 12 in-scope files, the sorted
      11-path marker set, and a clean yaml scan — all captured **to a log file** (per CLAUDE.md,
      not scrolled), verbatim with their exact command lines, in the amendment log.

## Dev Agent Record

<!-- Empty placeholder — filled during development. -->
