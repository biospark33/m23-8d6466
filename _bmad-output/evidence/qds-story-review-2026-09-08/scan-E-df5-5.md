# Scan E — DF5.5 KEEP-Repoint Chore (adversarial pre-dev review, 2026-09-08)

**Target:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df5-5-keep-repoint-chore.md`
(2 pts, 276 lines, last touched 2026-08-12)
**Reviewer:** scan agent E (solo). **Mode:** read-only. No file was edited.
**Drift rule applied:** shipped reality (current story files, current `sprint-status.yaml`, git
history) wins, unless it contradicts `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`.

Every claim below was verified by an actual read or grep run in this session. Commands are given
inline so the fixer can re-run them.

---

## 1. Verified-correct elements (SACRED — must not be regressed by any later fix wave)

These were checked mechanically and are right. A later fix wave that "corrects" any of them is
introducing a defect.

| # | Element | Verification |
|---|---|---|
| VC-1 | **Amendment A's occurrence table is line-exact, 26 days later.** Every file/line pair in the table at `df5-5:142-153` still holds against the current tree. | `for f in _bmad-output/sprint-artifacts/phase-1/stories/p1-{2,3,5,7,9,11,12,14,18}-*.md _bmad-output/sprint-artifacts/phase-0/stories/p0-{5,7,9}-*.md; do grep -nE 'P1\.(1\|4\|6\|8\|10\|13\|15\|16\|17\|19)\b' "$f"; done` → p1-2:26 · p1-3:22,24,39,46,138,142,147,154,155 · p1-7:26 · p1-9:25 · p1-11:25,48,51 · p1-12:25,31,39 · p1-14:24,26 · p1-18:17,23,25,50 · p0-7:55,136 · p0-9:198,218. **Exact match, zero drift.** |
| VC-2 | **p1-5 and p0-5 hit-counts.** p1-5 = zero retired-ID hits (boundary-only, amendment C); p0-5 = zero hits, never opened. | Same command; both returned no lines. |
| VC-3 | **The 12 / 11 / 10 arithmetic in §Overview (`:26-45`) reconciles.** 11 KEEP (audit §4 counts: P0.5, P0.9, P1.2, P1.3, P1.5, P1.7, P1.9, P1.11, P1.12, P1.14, P1.18) + P0.7 DONE-KEEP = 12 in verification scope; 10 files carry retired IDs + p1-5 boundary-only = 11 amended; p0-5 excluded. | Audit §4 line 131 + the grep above. |
| VC-4 | **p0-7:136 really carries three `P1.1` mentions**, as the table's "(×3)" claims. | `sed -n '136p'` — "P1.1 (A2A delegation)", "coordinated updates to P0.9 and P1.1", "in P0.9 and P1.1 reference these schemas". |
| VC-5 | **Amendment B's NOT-FOUND claims all hold.** `exitStatus` occurs **zero** times in `p1-11` and `p1-14`. p1-11:44 is the Hindsight REST transport table row (`recall \| POST /v1/default/banks/{bank_id}/memories/recall …`); p1-14:29 is blank. | `grep -c 'exitStatus' p1-11… p1-14…` → `0`, `0`; `sed -n '44p'`, `sed -n '29p'`. |
| VC-6 | **Amendment B's corpus sweep result holds.** The only 4-value enum listing in the story corpus is `exit_class` at `p0-4-hard-guard-kill.md:39`: "`exit_class` enum: `success \| transient \| overflow \| logic`". P0.4 is RETIRE → not edited (AC5/INV-2). | `grep -rn 'exit_class' _bmad-output/sprint-artifacts/phase-{0,1}/stories/`; `sed -n '39p' p0-4…`. |
| VC-7 | **The `costCents` drift record is accurate.** `costCents` appears at `p1-14:30` (inside AC1), `:37`, `:40`. It is AC substance → INV-1 correctly forbids the edit; DD-9 settles µ$ and DF2.8 restates 5,000,000 µ$. | `grep -n 'costCents' p1-14…`. |
| VC-8 | **Amendment E's already-satisfied verdict holds.** `df2-3-credential-lifecycle.md:123` carries `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd` verbatim, and `:125` names DF3.6's `loadResidentBounds` in the same paragraph. Re-applying E would rewrite a correct copy. Retiring E is right. | `grep -n 'residentSpendCeilingMicros\|loadResidentBounds' df2-3…`. |
| VC-9 | **AC4's precondition passes today.** All nine successor IDs the amendments actually write resolve to files on disk: `df1-3-dual-retry-discipline.md`, `df1-5-roster-config-slug-validation.md`, `df1-6-dispatch-task-team-runtime.md`, `df1-8-run-capture-issue-correlation.md`, `df2-8-cost-ledger-budget-cap.md`, `df3-1-dispatcher-core-verbs.md`, `df5-2-host-side-pr-creation.md`, `df5-3-audit-chain-extended.md`, `df6-1-pr-feedback-fix-loop.md`. | `ls _bmad-output/sprint-artifacts/dark-factory-v5/stories/`. |
| VC-10 | **No repoint has been applied to any of the 12 story files.** Zero `DF<n>.<m>` occurrences in any of them — no already-applied edits, no revert hazard *inside the story files*. (The `sprint-status.yaml` side is different — see DF5.5-B1/H1.) | `grep -nE 'DF[0-9]+\.[0-9]+'` over all 12 → no output. |
| VC-11 | **No `v5 amendment (DF5.5)` marker exists in either story directory yet.** Unscoped repo grep returns exactly 2 paths: the epics doc and this story file — both outside the two scoped directories, exactly as `:60-63` predicts. The directory-scoped marker grep is a sound completion signal. | `grep -rl 'v5 amendment (DF5.5)' .`. |
| VC-12 | **The DF1.10/DF1.11 renumbering trap does not fire here.** `DF1.10` appears **nowhere** in `df5-5-keep-repoint-chore.md`; the successor map contains no DF1.x target other than DF1.3/1.5/1.6/1.8. The pre-2026-08-31 authoring date did **not** contaminate this story's edit list. | Full read of the story file. |
| VC-13 | **The AC1 regex does not false-positive on `P1.11` / `P1.12` / `P1.14` / `P1.18`.** The `\b` anchor after each alternative rejects the two-digit continuations; p1-11 matched only 3 of its many self-referential lines. | Empirical — the VC-1 command. |
| VC-14 | **The DoD carries a real mechanical check.** Unlike most chore stories, DF5.5's DoD (`:261-272`) specifies a retired-ID grep, a directory-scoped marker grep, a **table-driven per-pair assertion** (wrong-successor MUST fail), and a synthetic missing-successor halt test. The `grep -v 'DF[0-9]'` weakness is explicitly named at `:85-89` and backed. **This is falsifiable as written** — the only gap is coverage (see DF5.5-H1). |
| VC-15 | **DD-7's role line is not contradicted by the ADR.** The ADR relocates tier 2 (resident + engine) in-box; SwarmClaw is a *host-side query chassis* and the audit chain / cost view remain host-side (ADR `:95` keeps the approval gate host-side; DF5.1 host re-verify unchanged). Amendment D's text is ADR-compatible. |
| VC-16 | **Spec Reference citations resolve.** Audit line 24 is verbatim the KEEP amendment allowance quoted at `df5-5:10-11`. Register §4 carries both boundary pairs (`DF1.3 ↔ P1.9`, `DF1.5 ↔ P1.5`) and DD-7's role sentence at register `:52`. |

---

## 2. Edit-by-edit verification table (the centrepiece)

Verdict key: **VALID** = apply as written · **STALE-TEXT** = target text/number moved · **WRONG-TARGET-ID** = would write the wrong successor or a contradicted edge · **ALREADY-APPLIED** = done elsewhere, re-applying is noise or a revert · **OBSOLETE** = should not be applied at all.

### Amendment A — dependency-edge repoints

| # | File | Line | Prescribed edit | Target exists? | Text verbatim? | Verdict | Note |
|---|---|---|---|---|---|---|---|
| A1 | `p1-2-qds-intake-issue.md` | 26 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID (with gloss defect)** | Line reads `**Dependency edges (predecessors):** P1.1 (Dev Manager registered as A2A agent).` A bare ID swap yields "DF3.1 (Dev Manager registered as A2A agent)" — DF3.1 is *Fleet Dispatcher Core Verbs*. See DF5.5-M1. |
| A2 | `p1-3-seeds-decompose-mirror.md` | 22 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | `/api/a2a` surface dependency. Mechanism is dead (see DF5.5-M2) but the edge repoint itself is correct. |
| A3 | `p1-3` | 24 | `P1.1` → `DF3.1` (×5 on the line) | ✅ | ✅ | **VALID** | Five `P1.1` mentions on one line; all forward-looking. |
| A4 | `p1-3` | 39 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | Inside AC4 prose. **INV-1 collision** — see DF5.5-B2. |
| A5 | `p1-3` | 46 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | "matching P1.6's convention" — forward-looking contract reference. |
| A6 | `p1-3` | 138 | `P1.1` → `DF3.1` (×2) | ✅ | ✅ | **VALID** | Ownership paragraph. |
| A7 | `p1-3` | 142 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | Error-code range note. Line also names `P1.3` (KEEP, not retired) — do not touch. |
| A8 | `p1-3` | 147 | `P1.1` → `DF3.1` (×2) | ✅ | ✅ | **VALID** | requestId propagation (CC-9). |
| A9 | `p1-3` | 154 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | **DoD line** — INV-1 collision, see DF5.5-B2. |
| A10 | `p1-3` | 155 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | **DoD line** — INV-1 collision, see DF5.5-B2. |
| A11 | `p1-7-lsp-diagnostics-gate.md` | 26 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | Line: `P0.6, P1.6 — **P0.6 is DONE** (PR #42, merged 2026-07-25)`. P0.6 is DONE-KEEP, untouched. |
| A12 | `p1-9-restart-policy.md` | 25 | `P1.8` → `DF1.8` | ✅ | ✅ | **VALID (yaml diverges)** | Story file dep = `P1.8.`; `sprint-status.yaml:99` dep = `[P1.6]` with a 2026-07-28 note saying re-evaluate P1.8. Two different edges for one story. See DF5.5-H2. |
| A13 | `p1-11-hindsight-prime-retain.md` | 25 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | Line: `P0.9, P1.6`. |
| A14 | `p1-11` | 48 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | Inside a long AC-narrowing paragraph (P1.11-R5-4). Check INV-1 scope. |
| A15 | `p1-11` | 51 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID (incomplete)** | Line names `src/protocol/phase-executor.ts` as "a P1.6 artifact". Repointing the ID leaves a module path that v5 does not build. See DF5.5-H3. |
| A16 | `p1-12-mulch-prime-record.md` | 25 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | |
| A17 | `p1-12` | 31 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | Inside AC3 — INV-1 collision, see DF5.5-B2. |
| A18 | `p1-12` | 39 | `P1.6` → `DF1.6` (×2) | ✅ | ✅ | **VALID (incomplete)** | Same `src/protocol/phase-executor.ts` problem as A15. |
| A19 | `p1-14-outcome-record-router.md` | 24 | `P1.13` → `DF2.8` | ✅ | ✅ | **VALID** | Line also names `P1.5` (KEEP) — do not touch. |
| A20 | `p1-14` | 26 | `P1.13` → `DF2.8` | ✅ | ✅ | **VALID** | Same; `P1.5` stays. |
| A21 | `p1-18-pr-comment-polling.md` | 17 | `P1.15` → `DF5.2` | ✅ | ✅ | **OBSOLETE** | Sentence is "After a PR is produced (P1.15), … **SwarmClaw must detect these comments** … via GitHub webhook". DF6.1 `:65-66,107-108,143` declares webhook ingress out of scope for v5.0. See DF5.5-H4. |
| A22 | `p1-18` | 23 | `P1.15` → `DF5.2` | ✅ | ✅ | **OBSOLETE** | Same paragraph family. |
| A23 | `p1-18` | 25 | `P1.15` → `DF5.2` | ✅ | ✅ | **ALREADY-APPLIED (yaml) / VALID (file)** | `sprint-status.yaml:105` **already** reads `P1.18 … deps: [DF5.2]`. The story file still reads `P1.15`. Two owners, one edge. See DF5.5-B1. |
| A24 | `p1-18` | 50 | `P1.19` → `DF6.1` | ✅ | ✅ | **WRONG-TARGET-ID** | Writes an edge DF6.1 explicitly denies: *"P1.18 is **not** a predecessor: its webhook receiver is out of scope for v5.0"* (`df6-1…md:65-66`). See DF5.5-B3. |
| A25 | `p0-9-hindsight-banks-mulch.md` | 198 | `P1.6` → `DF1.6` | ✅ | ✅ | **VALID** | "Mulch priming consumers (e.g., P1.6) should:" — forward-looking consumer contract. |
| A26 | `p0-9` | 218 | `P1.1` → `DF3.1` | ✅ | ✅ | **VALID (provenance ambiguity)** | Line is a JSON-RPC **error-code range allocation** record (`-32010..-32013` = P1.1). This is closer to a shipped-allocation record than a forward-looking edge; the annotation form `(now DF3.1)` is arguably correct. See DF5.5-M3. |
| A27 | `p0-7-swarmclaw-agent-mcp-hindsight.md` | 55 | `P1.1` **kept**, annotate `(now DF3.1)` | ✅ | ✅ | **VALID** | Comment inside an illustrative snippet describing a shipped registration requirement. Provenance rule correctly applied. |
| A28 | `p0-7` | 136 | all three `P1.1` → `DF3.1` | ✅ | ✅ | **VALID** | Downstream-contract-stability paragraph; genuinely forward-looking. Line also names `P0.9` (KEEP) — untouched. |

### Amendments C / D / E and the framing claims

| # | Edit | Verdict | Note |
|---|---|---|---|
| C1 | `p1-9` boundary blockquote after `:25` | **STALE-TEXT (factually wrong)** | Blockquote asserts P1.9 is "keyed on the CC-1 exitStatus enum". P1.9 contains **zero** occurrences of `exitStatus`; its own contract (`p1-9:36`) is `FailureClass = 'transient' \| 'overflow' \| 'logic'` — three values, not CC-1's five. See DF5.5-B4. |
| C2 | `p1-5` boundary blockquote after `:26` | **VALID** | Insertion point confirmed (`p1-5:26` is the `**Dependency edges (predecessors):**` line). Text matches register §4 (`:59`). DF1.5 is `done` and shipped `src/phase-engine/roster/{schema,validate}.ts` + `config/rosters/qds-default.roster.yaml`, so the ownership claim is true in shipped reality. |
| D1 | `p0-7` DD-7 role blockquote below H1 (`:1`) | **VALID (one stale clause)** | H1 confirmed at `p0-7:1`. "the natural HTTP home for DF5.3's audit-chain query and **DF2.8's cost view** if either needs one" — DF2.8 is `done` and shipped a CLI (`qds cost`), no HTTP surface. The conditional "if either needs one" keeps it from being false. LOW; see DF5.5-L1. |
| E1 | `df2-3` ceiling-chain tightening | **OBSOLETE (correctly retired)** | VC-8. `df2-3` must appear in no hunk. |
| F1 | E2E Slice `:49` "the DF slate frozen at **31 IDs**" | **STALE-TEXT** | Slate is **37 stories / 151 pts** (`sprint-status.yaml:37-44`). See DF5.5-H5. |
| F2 | AC4 `:110` "not over the full **31-ID** slate" | **STALE-TEXT** | Same. |
| F3 | Spec Reference `:15` `R5-dependency-sizing.md` | **STALE-TEXT** | Bare filename, no directory. Real path: `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`. See DF5.5-M4. |
| F4 | Trigger Surface `:121` — `sprint-status.yaml` **out-of-scope** | **WRONG** | Nine `sprint-status.yaml` KEEP rows say "deps repoint via DF5.5". See DF5.5-B1. |
| F5 | `:62` "an unscoped `grep -rl` returns 13+ paths" | **VALID** | Pre-chore = 2; post-chore = 11 amended + this story + epics doc + the new test = 14. "13+" holds. |

**Aggregate:** 28 amendment-A edits + 5 C/D/E edits + 5 framing claims = **38 checked items**.
**VALID 26 · STALE-TEXT 5 · WRONG-TARGET-ID 1 · ALREADY-APPLIED 1 · OBSOLETE 3 · WRONG (scope) 1**
(A23 is counted once, as ALREADY-APPLIED on the yaml side.)

---

## 3. Findings

### BLOCKERs

---

**DF5.5-B1 — `sprint-status.yaml` is orphaned: the file says DF5.5 owns its repoints, DF5.5 says it doesn't.**
**Severity:** BLOCKER
**Files:** `_bmad-output/sprint-artifacts/df5-5…md:121` (Trigger Surface row) and `:212-228`
(Files to Modify) vs `_bmad-output/sprint-artifacts/sprint-status.yaml:92,93,95,97,99,101,102,104`
(and `:105`).

**Defect.** Eight phase-1 KEEP rows in `sprint-status.yaml` carry the literal trailing comment
`# KEEP per F14; deps repoint via DF5.5`, and their `deps:` arrays still hold retired IDs
(`P1.2 … deps: [P1.1]`, `P1.7 … deps: [P0.6, P1.6]`, `P1.9 … deps: [P1.6]`, `P1.11/P1.12 … deps:
[P0.9, P1.6]`, `P1.14 … deps: [P1.5, P1.13]`). DF5.5's Trigger Surface marks
`sprint-status.yaml` **out-of-scope**, deferring it to "Phase 3 wrap-up (register §1), not a
story", and `sprint-status.yaml` appears nowhere in Files to Modify. So the file that names
DF5.5 as its repointer is a file DF5.5 refuses to open. Worse, `P1.18`'s row at `:105` has
**already** been repointed to `deps: [DF5.2]` by some other hand, proving the yaml is being
edited ad hoc while DF5.5 disclaims it. AC1's retired-ID grep does not scan the yaml, so DF5.5
can pass every gate with eight retired-ID dependency arrays left standing.

**Failure scenario.** DF5.5 lands, both greps return green, the story is marked done and
"no KEEP story points a developer at a retired ID" is recorded as satisfied. Six weeks later a
developer runs a dependency-graph query over `sprint-status.yaml` to pick the next unblocked
story, sees `P1.11 deps: [P0.9, P1.6]`, and treats P1.6 — a `superseded` story with a dead
`warren run --team` mechanism — as a live blocker. The one artifact machines actually read is the
one the chore skipped.

**Fix recipe (choose ownership explicitly; recommend option A).**

*Option A (recommended) — bring the yaml in.* Replace the Trigger Surface row at `:121` with:

```
| `sprint-status.yaml` phase-1 KEEP rows (`deps:` arrays + the `deps repoint via DF5.5` comments) | in-scope | `tests/backlog/keep-repoints.test.ts` (yaml retired-ID scan) | — |
| `sprint-status.yaml` DF epic blocks + per-story disposition marks | out-of-scope | — | Phase 3 wrap-up (register §1), not a story |
```

Add to Files to Modify (`:216`, before the test-path line):

```
- `_bmad-output/sprint-artifacts/sprint-status.yaml` — the eight phase-1 KEEP `deps:` arrays
  (P1.2, P1.3, P1.5, P1.7, P1.9, P1.11, P1.12, P1.14), repointed per the successor map; each
  row's `deps repoint via DF5.5` comment replaced by `# KEEP per F14; deps repointed by DF5.5
  2026-XX-XX`. P1.18's row is ALREADY repointed to `[DF5.2]` — do not re-write it.
```

Add AC1 bullet three:

```
   - **YAML retired-ID grep**: `grep -nE 'deps: \[[^]]*P1\.(1|4|6|8|10|13|15|16|17|19)\b' _bmad-output/sprint-artifacts/sprint-status.yaml`
     returns **zero lines** for rows whose story key is a KEEP story (P1.2, P1.3, P1.5, P1.7,
     P1.9, P1.11, P1.12, P1.14, P1.18). Rows for `superseded` stories are historical record and
     keep their retired-ID deps (INV-2 analogue).
```

*Option B — keep it out, but stop the yaml claiming otherwise.* Then DF5.5 must add a finding to
its amendment log recording that eight yaml rows carry a stale `deps repoint via DF5.5` promise
that no story discharges, and the Follow-Up column must name a real owner and date, not
"Phase 3 wrap-up". Option B leaves the retired IDs in place and is the weaker choice.

---

**DF5.5-B2 — INV-1 forbids the edits amendment A prescribes on five lines.**
**Severity:** BLOCKER
**Files:** `df5-5…md:231-235` (INV-1) vs the amendment-A table rows for `p1-3:39,154,155`,
`p1-12:31`, and `p1-11:48`.

**Defect.** INV-1 states: "No `## Acceptance Criteria`, `## Definition of Done`, or
`## Security Invariants` line in **any file this chore edits** changes … Enforced by reviewing the
diff per file: **an AC-line hunk is a rejection.**" AC2 restates it: "neither file's Acceptance
Criteria block has changed by a single character." But amendment A's own occurrence table orders
edits to lines that sit inside exactly those blocks:

- `p1-3:39` — inside Acceptance Criteria (AC4: "Given a valid A2A delegate request … the Seeds agent receives the request via P1.1's routing").
- `p1-3:154` and `p1-3:155` — inside `## Definition of Done` ("**Impl:** Seeds agent registers with P1.1 A2A layer…").
- `p1-12:31` — inside Acceptance Criteria (AC3, the `mulchPrimed:false` clause, "pinned to P1.6's run-state schema").
- `p1-11:48` — inside a bullet that narrows AC1/INV-MEM-2 and quotes them.

The story never reconciles this. A dev applying amendment A produces AC-line and DoD-line hunks,
which INV-1's own enforcement rule says are a rejection; a dev honouring INV-1 leaves five
retired-ID lines un-repointed, and AC1's grep then returns non-zero → the chore cannot pass.
The two make-or-break conditions are mutually unsatisfiable as written.

**Failure scenario.** Dev applies all 28 edits, opens the PR. Reviewer runs the INV-1 per-file diff
review, sees `p1-3` DoD hunks and a `p1-12` AC hunk, and rejects. Dev reverts those five, re-runs
AC1's grep — five lines survive → AC1 fails. The story deadlocks in review and someone
"resolves" it by quietly weakening INV-1, which is the exact guard protecting nine draft stories'
contract surfaces from a chore.

**Fix recipe.** INV-1's intent is "no AC *substance* changes", not "no AC line is touched" — the
audit's allowance (audit `:24`) permits "dependency-edge repoints … and single-line factual
amendments … anything touching an AC's **substance** is not". Rewrite INV-1 at `:231-235` to:

```
- INV-1: **Edit scope is bounded to non-normative substance.** No `## Acceptance Criteria`,
  `## Definition of Done`, or `## Security Invariants` line in any file this chore edits may
  change in **substance**. The single permitted class of change inside those blocks is a
  successor-ID substitution or provenance annotation drawn verbatim from the successor map — an
  identifier swap, nothing else. Enforced by reviewing the diff per file: an AC/DOD/INV hunk
  whose before/after differ by anything other than a mapped `P1.x` → `DF<n>.<m>` substitution
  (or the addition of `(now DF<n>.<m>)`) is a rejection. The five known in-block edits are
  `p1-3:39` (AC4), `p1-3:154`, `p1-3:155` (DoD), `p1-12:31` (AC3) and `p1-11:48`
  (AC1/INV-MEM-2 narrowing bullet); any sixth in-block hunk is a rejection on sight.
```

And amend AC2 at `:93-95`, replacing "neither file's Acceptance Criteria block has changed by a
single character" with:

```
   and neither file's Acceptance Criteria block changes at all — P1.9 and P1.5 carry no
   retired-ID hits inside their AC blocks (verified: p1-9's only hit is :25, p1-5 has none), so
   for these two files the zero-character rule holds literally.
```

Add a DoD item after `:260`:

```
- [ ] **Security:** The five in-block edits (`p1-3:39,154,155`, `p1-12:31`, `p1-11:48`) are
      listed in the amendment log with their before/after text, and each diff is an
      identifier-only substitution — reviewed line by line, not by hunk count.
```

---

**DF5.5-B3 — the `p1-18:50` repoint writes an edge DF6.1 explicitly denies.**
**Severity:** BLOCKER
**Files:** `df5-5…md:151` (table row) and `:160-163` (the "folded into this table" note) vs
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df6-1-pr-feedback-fix-loop.md:65-66`
and `sprint-status.yaml:105`.

**Defect.** Amendment A instructs `P1.19 → DF6.1` at `p1-18:50`. That line reads: "Bot comment
body is stored as a truncated snippet … while preserving sufficient context for downstream fix
dispatch (P1.19)." Repointing it asserts that P1.18's stored snippet feeds DF6.1. DF6.1's own
spec, written after DF5.5, says the opposite in three places: *"(P1.18 is **not** a predecessor:
its webhook receiver is out of scope for v5.0 — see AC3 and the Trigger Surface)"* (`:65-66`);
*"Inbound webhooks … are **out of scope for v5.0**: DD-1 makes the operator the channel, no
webhook ingress exists in the v5 slate"* (`:107-108`); and the Trigger Surface row at `:143`.
`sprint-status.yaml:105` agrees: "UNSCHEDULED — not in the v5 window. **DF6.1 no longer depends on
it**: v5.0 polls `gh pr checks` host-side instead". Register DD-2 ("P1.18 (KEEP) repoints to
DF6.1", register `:47`) is the stale source DF5.5 inherited; under the drift rule the shipped DF6.1
story and the yaml win over the register.

**Failure scenario.** The repoint lands. A developer later assigned P1.18 (it is still KEEP,
still `draft`) reads "downstream fix dispatch (DF6.1)", opens DF6.1, and builds the SwarmClaw
webhook receiver + HMAC signature validation (P1.18 INV-1) to feed a consumer that does not
consume it — v5.0's fix loop takes its input from `gh pr view --json headRefOid,statusCheckRollup`
host-side polling. That is a full story's worth of dead work, produced *by* the chore whose stated
purpose is "so that I do not build against a dead premise."

**Fix recipe.** Replace the `p1-18` row at `df5-5…md:151` with:

```
| `p1-18-pr-comment-polling.md` | 17, 23, 25, 50 | L25 (dependency edge): P1.15 → DF5.2. L17, L23, L50: **annotate, do not repoint** — see the P1.18 disposition note below |
```

And add immediately after the table (after `:163`):

```
  **P1.18 disposition (2026-09-08 correction).** P1.18 is KEEP but **UNSCHEDULED** — outside the
  v5 window and not counted in the DF 37/151 (`sprint-status.yaml:50-51,105`). Its mechanism (a
  SwarmClaw webhook receiver at `/api/webhooks/[id]` with HMAC signature validation) is out of
  scope for v5.0 per DD-1 and DF6.1 AC3, and **DF6.1 declares P1.18 not a predecessor**
  (`df6-1-pr-feedback-fix-loop.md:65-66,107-108,143`). Register DD-2's "P1.18 repoints to DF6.1"
  is superseded by DF6.1's shipped text. Therefore only the dependency edge at L25 is repointed
  (`P1.15` → `DF5.2`, which `sprint-status.yaml:105` has already applied on the yaml side). The
  three narrative references get a single shared annotation rather than a repoint, inserted as a
  blockquote below the H1:

  > **v5 amendment (DF5.5):** P1.18 is KEEP but UNSCHEDULED for v5.0. The PR that its polling
  > watches is now produced by **DF5.2** (host-side PR creation). The downstream fix dispatch it
  > feeds was **DF6.1**, but DF6.1 explicitly does not consume this story — v5.0 has no webhook
  > ingress (DD-1) and DF6.1 polls `gh pr view --json headRefOid,statusCheckRollup` host-side
  > instead. Do not build this story's webhook receiver expecting DF6.1 to read it.

  This keeps `p1-18` in the 11-path marker set and clears its four retired-ID lines under AC1
  (each surviving `P1.15`/`P1.19` mention is on a line that names its DF successor, or the
  annotation supplies it on the same line — verify per-pair, not by the plain grep).
```

---

**DF5.5-B4 — amendment C's P1.9 blockquote states a fact P1.9's own text contradicts.**
**Severity:** BLOCKER
**Files:** `df5-5…md:178-180` vs `p1-9-restart-policy.md:17,29,36`.

**Defect.** The blockquote DF5.5 orders inserted into P1.9 reads: "P1.9 owns **cross-run** restart
classification keyed on the CC-1 **exitStatus** enum." Verified against the file: `exitStatus`
occurs **zero** times in `p1-9-restart-policy.md`. Its Overview (`:17`) says SwarmClaw "classifies
the failure signal into one of **three** categories"; AC1 (`:29`) says "the classification is
`transient`, `overflow`, or `logic`"; and its contract line (`:36`) pins
`FailureClass = 'transient' | 'overflow' | 'logic'`. CC-1's exitStatus enum is **five**-valued
(`success | transient | overflow | logic | lead_failure`, `p0-3-mixed-model-demo.md:126`). The
claim is inherited verbatim from audit `:90` ("policy is keyed on the exitStatus *enum*") and
register `:58` — the same class of label drift that DD-8 was written for and that amendment B
correctly caught twice. DF5.5 catches it nowhere.

**Failure scenario.** The blockquote lands directly above P1.9's untouched AC1. A developer reads
"keyed on the CC-1 exitStatus enum" three lines above "the classification is `transient`,
`overflow`, or `logic`", concludes the ACs are stale, and either (a) widens `FailureClass` to five
values — an AC-substance change INV-1 forbids and DF5.5's diff review would reject — or (b)
implements a five-value classifier against three-value acceptance criteria and the story's
`FailureSignal` contract, and the make-or-break AC1 determinism test fails on `success` and
`lead_failure` inputs the story never defined behaviour for. The chore whose whole job is to stop
developers building against a dead premise plants one.

**Fix recipe.** Replace `df5-5…md:178-180` with:

```
  - `p1-9-restart-policy.md`: P1.9 owns **cross-run** restart classification — its own
    three-value `FailureClass` (`transient | overflow | logic`, `p1-9:36`), which is the failure
    subset of the CC-1 five-value `exitStatus` enum (`success | transient | overflow | logic |
    lead_failure`); the classification input is a `FailureSignal`, not an `exitStatus` literal,
    and this amendment changes neither. **In-phase** retry — JSON-parse and gate-violation
    retries re-entering the same agent session — is **DF1.3's**, separately bounded. In-box
    process supervision is neither: DF2.10 ships `qds-run@.service` with **`Restart=no`** and
    DF1.10 owns reclaim semantics (`df1-10-in-box-phase-engine.md:91,143`); a crashed in-box
    engine is **not** restarted by systemd and is not P1.9's cross-run classification either.
```

Add a companion note in Technical Notes recording the correction so the closed records are not
edited (INV-3):

```
- **Amendment C erratum (recorded, DD-8 class).** Audit §2's P1.9 row and register §4 both say
  P1.9's policy is "keyed on the exitStatus enum". Verified 2026-09-08: `exitStatus` occurs zero
  times in `p1-9-restart-policy.md`; the story's contract is a three-value `FailureClass` over a
  `FailureSignal` (`p1-9:17,29,36`). The blockquote text is corrected here rather than in the
  closed audit or the register; the amendment log records the grep
  (`grep -c 'exitStatus' _bmad-output/sprint-artifacts/phase-1/stories/p1-9-restart-policy.md` → `0`).
```

---

### HIGHs

---

**DF5.5-H1 — the DoD's mechanical check does not scan the artifact most likely to be wrong.**
**Severity:** HIGH
**Files:** `df5-5…md:261-272` (DoD), `:130` (Infra Prerequisites), `:79-89` (AC1).

**Defect.** DF5.5's completion check is unusually good for a chore (VC-14) but its scan surface is
exactly the 12 story files. It does not scan `sprint-status.yaml` (DF5.5-B1), it does not scan the
epics index `_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md` (which
carries the KEEP ancestry table at `:732` and three DF-story dependency notes naming P1.2/P1.3/P1.7
at `:171,360,609`), and it has no regression arm — nothing fails if a *future* commit reintroduces
a retired ID into a KEEP story. `tests/backlog/` does not exist in the tree
(`ls tests/backlog/` → No such file or directory), so the whole check is greenfield and its exact
shape is whatever the dev writes.

**Failure scenario.** DF5.5 lands green. Two weeks later a story fixer editing `p1-11` for an
unrelated reason writes "per P1.6's schema" into a new paragraph. Nothing fails: the test asserted a
point-in-time zero, and the marker grep still returns 11 paths. The invariant the chore exists to
establish silently decays, and the next reader has no way to know which retired IDs are annotated
on purpose and which are rot.

**Fix recipe.** Rewrite the Infra Prerequisites row at `:130` and the DoD test items to specify the
check concretely:

```
| Verification greps | `tests/backlog/keep-repoints.test.ts` (bun test, repo-root CWD) | Four assertions, all executed from `process.cwd()` resolved to the repo root via `import.meta.dir`: (1) **retired-ID scan** — for each of the 12 in-scope story files, every line matching `/P1\.(1|4|6|8|10|13|15|16|17|19)\b/` must also match the mapped successor `/DF<n>\.<m>/` **on the same line**; (2) **per-pair correctness** — a line naming a DF ID that is not the mapped successor for that retired ID FAILS (table-driven over the successor map, so a wrong-successor annotation cannot pass); (3) **marker set** — `grep -rl 'v5 amendment (DF5.5)'` over `phase-0/stories/` + `phase-1/stories/`, sorted, deep-equals the 11-path literal array (p0-5 absent); (4) **yaml scan** — no KEEP-story row in `sprint-status.yaml` has a retired ID inside its `deps: [...]`. Exit non-zero on any. |
```

and replace the DoD test items at `:261-268` with:

```
- [ ] **Test (regression, all four assertions):** `tests/backlog/keep-repoints.test.ts` runs under
      plain `bun test` (never excluded from a gate) and asserts: retired-ID-with-successor over
      the 12 story files; table-driven per-pair correctness (wrong successor MUST fail — the plain
      `grep -v 'DF[0-9]'` would pass it); the sorted 11-path marker set exactly; and zero retired
      IDs in the KEEP rows' `deps:` arrays in `sprint-status.yaml`.
- [ ] **Test (missing successor):** a synthetic map entry pointing at a nonexistent `DF9.9` story
      file → the precondition check fails and the test asserts the halt-and-log path (AC4), with
      no reference written.
- [ ] **Test (negative control — provenance):** a fixture line rewriting a shipped-PR reference
      (`shipped PR #40/#87`) into a DF ID passes assertion (1) and MUST fail assertion (2)'s
      provenance arm — forward-looking references are repointed, provenance references are
      annotated.
```

---

**DF5.5-H2 — `p1-9`'s dependency edge disagrees with itself across the two artifacts, and DF5.5 repoints only one side.**
**Severity:** HIGH
**Files:** `df5-5…md:147` (table row `p1-9 | 25 | P1.8 → DF1.8`) vs
`p1-9-restart-policy.md:25` (`P1.8.`) vs `sprint-status.yaml:99` (`deps: [P1.6]` + note).

**Defect.** The story file says P1.9 depends on P1.8; the yaml says P1.6, with a 2026-07-28 note:
"P1.8 revived (CC-6), so the earlier 'P1.8 removed (killed)' note is void — **re-evaluate whether
P1.8 belongs back in deps**". That re-evaluation was never done. DF5.5 repoints the story file to
DF1.8 and (per DF5.5-B1) touches nothing in the yaml, so after the chore P1.9 will read `DF1.8` in
one place and `P1.6` in the other — the chore hardens a divergence instead of resolving it, and
does so without recording that the divergence exists.

**Failure scenario.** A scheduler (human or the `qds-dev` skill's dependency check) reads the yaml,
sees `P1.6` — `superseded` — and treats P1.9 as blocked on a dead story forever. A developer reads
the story file, sees `DF1.8` — `done` — and starts. Two answers to "is P1.9 unblocked", both
sourced from artifacts this chore just certified.

**Fix recipe.** Add to the amendment-A table note (after `df5-5…md:156`):

```
  **`p1-9` edge divergence (recorded, resolve before applying).** `p1-9:25` names `P1.8`;
  `sprint-status.yaml:99` names `P1.6` and carries an unresolved 2026-07-28 note asking whether
  P1.8 belongs back in deps. The two disagree on which predecessor P1.9 has, so a mechanical
  repoint would harden the disagreement. Disposition: repoint **both** to the union of their
  mapped successors — `p1-9:25` becomes
  `**Dependency edges (predecessors):** DF1.6 (was P1.6, per sprint-status), DF1.8 (was P1.8, per this file) — v5 amendment (DF5.5)`
  and `sprint-status.yaml:99` becomes `deps: [DF1.6, DF1.8]`. Both DF1.6 and DF1.8 are `done`, so
  the union blocks nothing; recording both is strictly safer than picking one and is a
  dependency-edge repoint, which the KEEP amendment allowance covers (audit :24). Record the
  divergence and the resolution in the amendment log.
```

---

**DF5.5-H3 — repointing the ID without repointing the module path leaves P1.11/P1.12 pointing at a directory v5 does not build.**
**Severity:** HIGH
**Files:** `df5-5…md:148-149` (p1-11, p1-12 rows) vs `p1-11:51` and `p1-12:39`.

**Defect.** Both lines read `INTEGRATE: src/protocol/phase-executor.ts (prime/retain hooks…)` and
gloss it as "a P1.6 artifact". Amendment A swaps `P1.6` → `DF1.6` and stops. But the v5 module
roots are fixed by register §1 (`:23`): new engine code lives in `src/phase-engine/*`, not
`src/protocol/*`; `src/protocol/phase-executor.ts` does not exist and no DF story creates it. Since
the 2026-08-31 ADR the engine additionally runs **in-box** (DF1.10, `done` 2026-09-06), so the hook
seam these two stories describe is not merely at a different path — it is on a different machine.
The repoint therefore produces a line that names a live DF story next to a dead path, which reads
as authoritative.

**Failure scenario.** A developer picks up P1.11 (KEEP, `draft`), reads "INTEGRATE:
`src/protocol/phase-executor.ts` (a DF1.6 artifact)", finds no such file, and creates it — the
exact `src/memory/hindsight-client.ts`-style duplication the same line's REUSE clause was written
to prevent. Or they wire prime/retain hooks host-side into `scripts/pipeline-run.ts`, re-committing
the silent host-side deviation the ADR was written to unwind.

**Fix recipe.** Extend the two amendment-A rows at `:148-149` to carry a path amendment alongside
the ID repoint:

```
| `p1-11-hindsight-prime-retain.md` | 25, 48, 51 | P1.6 → DF1.6 (25, 51); P1.1 → DF3.1 (48). **At :51 also amend the path**: `src/protocol/phase-executor.ts` → `src/phase-engine/` (the v5 engine root, register §1) with the note below |
| `p1-12-mulch-prime-record.md` | 25, 31, 39 | P1.6 → DF1.6. **At :39 also amend the path**, same substitution and note |
```

and add to Technical Notes:

```
- **Amendment F — engine-seam path + placement note (ADR-derived, additive).** `p1-11:51` and
  `p1-12:39` name `src/protocol/phase-executor.ts` as the prime/retain hook seam. That path is
  pre-v5: register §1 puts engine code under `src/phase-engine/*`, and per the ACCEPTED
  2026-08-31 tier-2 placement ADR the engine runs **in-box** (DF1.10, done 2026-09-06), not on
  the host. Insert one blockquote below the H1 of each file:

  > **v5 amendment (DF5.5):** the prime/retain hook seam named below as
  > `src/protocol/phase-executor.ts` is pre-v5. The v5 phase engine lives under
  > `src/phase-engine/*` (derivation register §1) and, per the 2026-08-31 tier-2 placement ADR,
  > **runs inside the sandbox box** (DF1.10). Wire prime/retain against the in-box engine's phase
  > lifecycle, not a host-side executor. The M-PairB-1 edit-ordering note (P1.11 lands first,
  > P1.12 extends its hook) is unchanged.

  This is a dependency/pointer amendment, not an AC change: neither file's AC block is touched.
```

---

**DF5.5-H4 — the `p1-18` narrative repoints write DF-era IDs into a mechanism DD-1 killed.**
**Severity:** HIGH
**Files:** `df5-5…md:151` vs `p1-18:17,23` and register `:46` (DD-1).

**Defect.** `p1-18:17` and `:23` are narrative describing a **SwarmClaw webhook receiver**:
"the webhook payload arrives at SwarmClaw's `/api/webhooks/[id]` endpoint", "SwarmClaw receives the
webhook, validates the signature". DD-1 decided operator-CLI-only for v5.0 with no channel story,
and DD-7 demoted SwarmClaw from front door to dormant-retained query chassis. Substituting `DF5.2`
into those sentences produces "After a PR is produced (DF5.2), … SwarmClaw must detect these
comments … via GitHub webhook" — a sentence that reads as a live v5 contract between a `done` DF
story and an ingress path the slate has explicitly refused to build. This is the same defect class
as DF5.5-B3, one severity down because the ID itself (DF5.2 is genuinely P1.15's successor and did
produce the PR) is correct; only the surrounding premise is dead.

**Failure scenario.** A reader scanning for "who consumes DF5.2's PRs" greps the corpus, finds
`p1-18`, and reads a repointed, DF-annotated, apparently-current paragraph describing webhook
ingress. They spend a planning cycle re-litigating DD-1.

**Fix recipe.** Covered by DF5.5-B3's shared blockquote — the annotation names DD-1 and the absence
of webhook ingress on the same page as the repoint. If B3's recipe is taken, H4 is discharged with
it; do not apply a bare ID substitution at `:17`/`:23` without that blockquote present.

---

**DF5.5-H5 — the slate is 37 stories / 151 points; DF5.5 says 31.**
**Severity:** HIGH
**Files:** `df5-5…md:49` ("Given the DF slate frozen at **31 IDs**") and `:110` ("not over the full
**31-ID** slate") vs `sprint-status.yaml:37-49`.

**Defect.** `sprint-status.yaml:37-38` records "DF totals: **37 stories / 151 points** (DF1 10/45,
DF2 10/39, DF3 8/32, DF4 2/10, DF5 5/17, DF6 2/8)", reconciled both ways at `:39-40`, with
`:41-44` recording the ADR's +5 stories/+26 pts (DF2.10, DF1.10, DF1.11, DF3.7, DF3.8), DF3.6's
re-sequence, and DF6.2's absorption. DF5.5's "31" is the pre-ADR count and is the number its E2E
Slice uses to define the precondition for the whole chore ("Given the DF slate frozen at 31 IDs,
When the chore is applied…"). AC4 repeats it. Additionally `sprint-status.yaml:44-49` records the
**2026-09-08 status audit** — DF1.10, DF1.11 and DF3.5 flipped to `done` against git history and
the counter recomputed to 30/37 done, 125/151 pts — so the six DF IDs the chore's own dependency
edges name (`:69-72`) are all `done` today except DF5.3 and DF6.1.

**Failure scenario.** The E2E precondition is checked literally: the dev counts DF story files (38
including `df-future-hitl-pause-phase.md` and `df1-11b-reboot-arm-harness.md`), gets neither 31 nor
37, and either blocks the chore on a phantom precondition or waves it through unchecked. Either way
the "slate frozen" gate — the whole reason DF5.5 is scheduled last — stops functioning.

**Fix recipe.** At `:49`, replace "Given the DF slate frozen at 31 IDs" with:

```
**Demonstrable behavior:** Given the DF slate frozen at **37 stories / 151 points**
(`sprint-status.yaml:37-40`; +5 stories/+26 pts added 2026-08-31 by the tier-2 placement ADR —
DF2.10, DF1.10, DF1.11, DF3.7, DF3.8 — with DF3.6 re-sequenced to v5-S3 and DF6.2 absorbed), When
the chore is applied, Then the
```

At `:108-110`, replace the closing sentence with:

```
   rather than writing a dangling pointer. The precondition is over the nine IDs the amendments
   actually write, not over the full 37-ID slate; the count is asserted against
   `sprint-status.yaml`'s meta block, not hardcoded here.
```

Also add to the Spec Reference block at `:7-15`:

```
- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED) — §Consequences added
  DF2.10/DF1.10/DF1.11/DF3.7/DF3.8 and re-sequenced DF3.6 **after** this story was authored
  (2026-08-12); the slate this chore waits on is the post-ADR one. Renumbering warning:
  pre-2026-08-31 references to "DF1.10 owns the round trip" mean **DF1.11**. This story writes no
  DF1.10 or DF1.11 reference and is not affected by the renumbering — verified 2026-09-08.
```

---

### MEDIUMs

**DF5.5-M1 — bare ID substitution leaves false descriptive glosses.**
**Severity:** MEDIUM · **File:** `df5-5…md:144` vs `p1-2:26`.
`p1-2:26` reads `**Dependency edges (predecessors):** P1.1 (Dev Manager registered as A2A agent).`
The prescribed edit swaps the ID only, yielding "DF3.1 (Dev Manager registered as A2A agent)".
DF3.1 is *Fleet Dispatcher Core Verbs (dispatch, status, harvest, teardown)* — there is no A2A agent
registration in it; that mechanism died with P1.1's premise (audit `:82`). **Failure scenario:** a
developer picking up P1.2 opens DF3.1 expecting an A2A registration surface, finds four CLI verbs,
and concludes one of the two documents is wrong. **Fix:** prescribe replacement text, not
substitution, for every gloss-bearing line. For `p1-2:26`:
`**Dependency edges (predecessors):** DF3.1 (fleet dispatcher core verbs — the v5 factory front door; was P1.1 "Dev Manager registered as A2A agent", whose A2A front-door premise died with the SwarmClaw protocol engine, audit §2). <!-- v5 amendment (DF5.5) -->`
Audit every other repointed line for a parenthetical gloss before applying and give each one
replacement text in the amendment log.

**DF5.5-M2 — `p1-3`'s eight repointed lines all describe the unbuilt `/api/a2a` surface.**
**Severity:** MEDIUM · **File:** `df5-5…md:145` vs `p1-3:22,24,39,138,142,147,154,155`.
Every P1.1 mention in `p1-3` is about `/api/a2a`, `a2a.delegate(...)`, and P1.1's Transport
Contract. `p1-3:22` itself says the route "does not exist in source today". Repointing all eight to
DF3.1 asserts DF3.1 provides that surface; it does not. This is the same defect as M1 at eight
times the volume, and `p1-3` is the largest single block of amendment-A work. **Fix:** add one
blockquote below `p1-3`'s H1 rather than trusting eight bare substitutions:
`> **v5 amendment (DF5.5):** every P1.1 reference below is repointed to **DF3.1** (fleet dispatcher core verbs), P1.1's F14 successor. DF3.1 does **not** ship P1.1's \`/api/a2a\` route or \`a2a.delegate\` transport — that SwarmClaw-protocol-engine premise is dead (audit §2, DD-7). The v5 front door is the tier-1 CLI. This story's decompose invocation re-derives onto DF3.1's dispatch surface when P1.3 is scheduled; the A2A mechanics below are historical.`
then apply the eight substitutions.

**DF5.5-M3 — `p0-9:218` is an allocation record, not a forward-looking edge.**
**Severity:** MEDIUM · **File:** `df5-5…md:152`.
The row classifies `p0-9:218` as "JSON-RPC error-code range allocation" and prescribes a repoint.
The line records which range belongs to which story (`-32010..-32013` = P1.1) — a shipped
allocation in P0.9's merged bridge, which is exactly the provenance class the rule at `:156-160`
says keeps the old ID and gains `(now DF{n}.{m})`. The story's own rule contradicts its own table
row. **Failure scenario:** the reviewer applying the negative control at `:90-92` flags this as
provenance destruction and rejects; or it lands and the record of which *story* allocated the range
is lost. **Fix:** change the `p0-9` row's second clause to
`218: P1.1 **kept**, annotated \`(now DF3.1)\` — a shipped error-code range allocation in P0.9's merged bridge, so the provenance rule applies (same treatment as p0-7:55)`.

**DF5.5-M4 — the R5 citation is an unresolvable bare filename.**
**Severity:** MEDIUM · **File:** `df5-5…md:15`.
"`R5-dependency-sizing.md` §1.5 (this row), §2 (successor map), §5.2, §5.4" — no directory. The file
is at `_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md`, and
the successor map at `:136-138` is declared "binding; source R5 §2 + audit §2", so a dev who cannot
find R5 cannot verify the binding source of the chore's core table. **Fix:** replace `:15` with
`- Sizing/graph: \`_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md\` §1.5 (this row, \`:89\`), §2 (successor map), §5.2, §5.4 (\`:372\`, \`:392\` — SwarmClaw role + boundary amendments)`.

**DF5.5-M5 — `tests/backlog/` is a new top-level test directory with no sibling convention.**
**Severity:** MEDIUM · **File:** `df5-5…md:227,261`.
`ls tests/` shows domain directories (`fleet`, `gate`, `gitnexus`, `hindsight`, `phase-engine`,
`pr`, `providers`, `reverify`, `scripts`, `swarmclaw`, `lib`, `vendor`) plus flat `*.test.ts`.
`tests/backlog/` exists nowhere. A test that shells out to `grep` also depends on CWD, which
`bun test` does not guarantee. **Fix:** name the path `tests/scripts/keep-repoints.test.ts` (the
existing home for repo-hygiene checks) or keep `tests/backlog/` but state in Infra Prerequisites
that the test resolves the repo root from `import.meta.dir` and must not rely on `process.cwd()`.
Also add the CLAUDE.md log-capture discipline to the DoD e2e item: the run is captured to a file,
not scrolled.

### LOWs

**DF5.5-L1 — amendment D's "DF2.8's cost view" clause is counterfactual.** `df5-5…md:186-187`.
DF2.8 is `done` (PR #121, 2026-08-21) and shipped a CLI cost view, not an HTTP one. The
conditional "if either needs one" keeps the sentence true, so this is copy only. Optional fix:
"…the natural HTTP home for DF5.3's audit-chain query if it ever needs one (DF2.8 shipped its cost
view as a CLI surface, 2026-08-21)".

**DF5.5-L2 — "Eleven phase-0/phase-1 stories keep the KEEP disposition" over-counts by construction.**
`df5-5…md:26-29`. The sentence then lists nine p1 files "plus `p0-5` and `p0-9`" = 11, which is
right, but reads at first pass as though eleven *phase-1* stories are KEEP. Cosmetic; the following
sentences disambiguate correctly (VC-3).

**DF5.5-L3 — the epics index is stale about DF6 and is a silent marker-grep participant.**
`_bmad-output/implementation-artifacts/epics-and-stories-dark-factory-v5.md` says "Epic DF6 …
— 1 story · 6 pts" though DF6.2 (2 pts, `done`) was absorbed 2026-08-28. The index is out of DF5.5's
scope and its staleness does not affect any DF5.5 edit — but it is one of the two files that already
contains the `v5 amendment (DF5.5)` literal, so the scoped-grep justification at `:60-63` depends on
it continuing to exist. No action for DF5.5; flag to whoever owns the index.

---

## 4. Missing edits the ADR arc created

The 2026-08-31 ADR landed 19 days after DF5.5 was authored. Its §Consequences added five DF IDs,
re-sequenced a sixth, and relocated tier 2 in-box. None of that is in DF5.5's edit list. What
follows is what the arc *should* have added.

| # | Missing edit | Why the ADR creates it | Where it belongs |
|---|---|---|---|
| ME-1 | **Engine-placement note on `p1-11` and `p1-12`** (new amendment F). | Both stories wire prime/retain hooks into `src/protocol/phase-executor.ts`. The ADR moves the engine in-box (DF1.10, `done`); register §1 moves the path to `src/phase-engine/*`. A P1.6→DF1.6 ID swap fixes neither. | DF5.5 — recipe in **DF5.5-H3**. |
| ME-2 | **Supervision clause in `p1-9`'s boundary blockquote.** | ADR consequence 3 adds a third restart concept: DF2.10's `qds-run@.service` with **`Restart=no`** (`df2-10:106,112,173`) and DF1.10's reclaim semantics (`df1-10:91,143`). P1.9's title is literally "Restart Policy". Amendment C names only DF1.3. | DF5.5 — folded into **DF5.5-B4**'s replacement text. |
| ME-3 | **No new repoint targets.** Checked explicitly: none of the six retired IDs in the 12 in-scope files (P1.1, P1.6, P1.8, P1.13, P1.15, P1.19) has a successor that the ADR moved. DF3.1, DF1.6, DF1.8, DF2.8, DF5.2, DF6.1 are all unchanged by the ADR. | — | Nothing to add. **This is the good news:** the ADR arc did not invalidate a single successor-map row. |
| ME-4 | **Slate-count correction (31 → 37).** | ADR §Consequences +5 stories / +26 pts, plus DF6.2's absorption. | DF5.5 — recipe in **DF5.5-H5**. |
| ME-5 | **`sprint-status.yaml` KEEP `deps:` arrays.** | Not ADR-created, but 26 days of merges have made the yaml the artifact machines read and the story files the artifact humans read. P1.18's row was repointed by someone else in the interim. | DF5.5 — recipe in **DF5.5-B1**. |
| ME-6 | **DD-2 supersession record.** Register `:47` still says "P1.18 (KEEP) repoints to DF6.1"; DF6.1's shipped spec denies it. Register is ACTIVE, not closed, so it can be amended — but INV-3 says corrections go in the amendment log and, "if it changes a decision, in the decision register". This changes DD-2. | DF5.5's amendment log **and** a DD-2 addendum in the register. Candidate **PROPOSED ADR/register amendment** — do not resolve inside DF5.5's Technical Notes alone. |
| ME-7 | **Nothing for DF3.6.** Amendment E is correctly retired (VC-8) and DF3.6's re-sequence to v5-S3 changes no KEEP-story text. Verified: no KEEP story mentions DF3.6 or the ceiling chain. | — | Nothing to add. |

**No ADR-contradicting edit was found.** DF5.5 prescribes nothing that re-points an edge at the
rescinded host-side design, and it contains no `DF1.10` reference to mis-resolve (VC-12). The
renumbering trap the campaign warned about does **not** fire on this story.

---

## 5. Ownership recommendation — who writes which edge

The campaign is hardening DF3.6, DF3.7, DF3.8, DF5.3, DF5.4 and DF6.1 in parallel with this scan.
DF5.5 writes three of those IDs into files (DF5.3 in the role line, DF6.1 at `p1-18:50`, DF5.2 in
`p1-18:25`). To guarantee no edge is written twice by two owners:

**DF5.5 keeps (apply in DF5.5's own fix wave, last):**
- All 24 amendment-A repoints in `p1-2`, `p1-3`, `p1-7`, `p1-9`, `p1-11`, `p1-12`, `p1-14`, `p0-9`,
  `p0-7`. No sibling story touches these files; no other owner exists.
- Amendment C's two boundary blockquotes (corrected per DF5.5-B4), amendment D's role line,
  amendment F (ME-1), and the recorded dispositions for B and E.
- The `sprint-status.yaml` KEEP-row `deps:` repoints (DF5.5-B1 option A) — nothing else claims them,
  and the yaml is the artifact most likely to mislead a scheduler.
- `p1-18:25` (`P1.15` → `DF5.2`) — the yaml side is already done, the story side is not.

**DF5.5 hands off (remove from DF5.5's list):**
- **`p1-18:50` (`P1.19` → `DF6.1`) → DF6.1's fix wave.** DF6.1 already carries the authoritative
  statement that P1.18 is not a predecessor (`df6-1:65-66,107-108,143`). The annotation belongs
  with the story that owns the severance, and writing it from DF5.5 risks the two waves landing
  contradictory sentences. DF5.5 records the hand-off in its amendment log and its DoD asserts the
  line is annotated, not that DF5.5 annotated it. *(If DF6.1's wave declines it, DF5.5 applies
  DF5.5-B3's blockquote verbatim — but the ask goes to DF6.1 first.)*
- **The DD-2 register addendum (ME-6) → the campaign's ADR-amendment output**, not DF5.5's
  Technical Notes. INV-3 forbids DF5.5 from resolving a decision by editing prose.

**DF5.5 must re-verify after the campaign, before its first edit:**
- The nine successor IDs at `df5-5:69-72,106-107,129`. If the campaign splits or renumbers **DF5.3**
  or **DF6.1**, the role line and the `p1-18` annotation change target. AC4's precondition check is
  the right mechanism and already exists — but its input list is hardcoded in three places
  (`:69-72`, `:106-107`, `:129`) which will drift apart. **Recommend:** state the list once in
  Technical Notes and have the other three cite it.

**Sequencing:** unchanged and correct — DF5.5 goes last. Its yaml dependency row
(`sprint-status.yaml:118`, `deps: [DF1.3, DF1.5, DF1.6, DF1.8, DF2.8, DF3.1, DF5.2, DF5.3, DF6.1]`)
matches the story file exactly (VC-9 confirms all nine resolve); only DF5.3 and DF6.1 are not yet
`done`, so DF5.5 is correctly blocked behind exactly the two stories whose IDs it writes.

---

## 6. Sizing

**2 points does not hold. Recommend 3.**

The original 2 pts covered 28 mechanical substitutions + 3 blockquotes + 2 recorded dispositions.
The scan adds, without inventing scope: a new test file with four assertions in a directory that
does not exist (DF5.5-H1, DF5.5-M5); eight `sprint-status.yaml` rows (DF5.5-B1); an INV-1 rewrite
that requires per-line diff review of five in-block edits (DF5.5-B2); replacement *text* rather than
substitution for every gloss-bearing line (DF5.5-M1/M2 — `p1-3` alone is eight); a new amendment F
across two files (ME-1); and a corrected amendment C that required reading P1.9's contract to write
(DF5.5-B4). That is roughly a 50% increase in edit volume plus a genuinely new deliverable (the
regression test). The atomicity ceiling (≤8 SP, normative ≤200 lines) is not threatened; 3 pts is
honest. The story is at 276 lines total but its normative sections are well under 200.

**Do not split it.** Every edit shares one verification harness and one marker set; splitting would
require two stories to agree on the 11-path assertion.
