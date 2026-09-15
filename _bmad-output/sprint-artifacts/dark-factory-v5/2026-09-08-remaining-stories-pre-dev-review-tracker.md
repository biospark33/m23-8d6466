# QDS Pre-Dev Adversarial Review — the 7 remaining Dark-Factory-v5 stories (2026-09-08)

**Campaign:** `/qds-story-review` multi-wave adversarial review-and-fix.
**Scope:** the seven stories still `ready-for-dev` after the 2026-09-08 status audit.
**Why now:** every one of these specs was authored *before* the 2026-08-31 tier-2 placement
ADR was ratified and/or before DF1.10 / DF1.11 / DF2.10 actually shipped. They have never
been read against the substrate that now exists. Prior dev rounds surfaced this by accident
(an agent doing its bearings-check kept flagging "this isn't right") — this campaign does it
deliberately, once, before any of them enters dev.

---

## Ground rules (operator-ratified 2026-09-08)

1. **Scope:** DF3.6, DF3.7, DF3.8, DF5.3, DF5.4, DF5.5, DF6.1. Seven stories, 26 points.
2. **Drift rule — shipped code wins, *unless* it deviates from the ADR.** Where a spec
   contradicts what DF1.10/DF1.11/DF2.10/DF3.x actually shipped, the spec is rewritten
   against shipped reality. Where **shipped code itself** contradicts
   `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`, that is a **BLOCKER**,
   escalated to the operator as a PROPOSED ADR amendment — never silently spec'd around.
   This is precisely the rule whose absence produced the original silent deviation.
3. **Boundaries — full authority.** The campaign may re-split oversized stories, merge,
   create new story files, and re-point dependency edges in `sprint-status.yaml`. Structural
   changes are recorded here with rationale before they are executed.
4. **No TODO/FIXME.** A finding is resolved or escalated with a written reason.
5. **Parent-only tracker writes.** Subagents return reports + write to
   `_bmad-output/evidence/qds-story-review-2026-09-08/`; only the parent mutates this file.
6. **MEDIUMs and LOWs are not optional.** Done means every tier reaches ✅ or ⏭️ DEFERRED
   with a written reason.

## Fix-recipe doctrine (binding on every fix wave)

### The ladder — climb it before writing any fix recipe

Stop at the first rung that holds:

1. **Does this need to exist at all?** A speculative AC, a bound nothing can trip, an invariant
   already enforced a layer up — cut it and say so in one line.
2. **Already in this codebase?** A helper, type, seam, or pattern that already ships → reuse it.
   Re-specifying what lives a few files over is the most common slop in these stories, and the
   scan wave found it three independent times: DF3.6's RSS watchdog (reuse
   `src/reverify/worktree.ts:210-380`, don't rebuild), DF3.7's liveness arm (reuse `unitActivity`,
   whose docblock already enumerates the four meanings of an absent marker), DF5.4's approval
   read (reuse `extensions.approval`, don't invent `.sandbox/approvals/<id>.json`).
3. **Stdlib / native platform / already-installed dependency covers it?** Use it. Never add a
   dependency for what a few lines do. A systemd directive beats a polling loop; a DB constraint
   beats app code.
4. **Can it be one line?** One line.
5. **Only then:** the minimum spec text that works.

**Deletion over addition.** A fix that grows an AC to cover something already covered is
complexity smuggled back in as prose. The shortest correct spec wins.

**Never lazy about understanding.** The ladder shortens the *solution*, never the *reading*.
Read the ADR, the shipped code, and both halves of the contract in full, then climb. A small
diff in the wrong place is not lazy — it is a second defect wearing efficiency as a costume.

**Root cause, not symptom.** When a finding names one site, check every sibling call site before
editing. One guard in the shared function is a smaller diff than a guard in every caller — and
patching only the named path leaves every sibling still broken. DF1.1's history is the cautionary
tale: four review rounds hit the same sink because each fix was scoped to the reported site.

### What the ladder must NEVER simplify away

Input validation at trust boundaries · error handling that prevents data loss · security
invariants (one-secret-per-box, no push credential in-box, no `sk-or-` in any artifact,
redaction chokepoints) · the R9 two-layer evidence doctrine · anything the operator explicitly
asked for. Laziness is for mechanism, never for the trust boundary.

Where a fix lands as a code skeleton carrying a known ceiling, mark it: `// ponytail: ps-sampled,
cgroup-enforced if the bound needs to be un-bypassable`. The comment names the ceiling AND the
upgrade path, so the simplification reads as intent rather than ignorance.

### GitNexus over grep (per `CLAUDE.md`, mandatory)

- Getting bearings on unfamiliar code → `query({query: "concept"})`, not a grep sweep. It returns
  process-grouped execution flows ranked by relevance.
- Full context on a symbol (callers, callees, flows it participates in) → `context({name})`.
- **Before any edit that renames or restructures a symbol → `impact({target, direction:
  "upstream"})`.** HIGH or CRITICAL risk → STOP and surface to the parent. Never rename by
  find-and-replace; `rename` understands the call graph.
- After edits → `detect_changes()` to prove the change set is only what was assigned. For
  regression scope, `detect_changes({scope: "compare", base_ref: "main"})`.

These story files are Markdown, so most edits are doc-only and `detect_changes` should report
zero affected symbols — that zero IS the evidence, and a non-zero result means a fix wandered
out of scope.

## Pre-campaign correction landed (2026-09-08 status audit)

`sprint-status.yaml` carried three stale statuses, corrected against git history rather than
against story prose:

| Story | Was | Now | Evidence |
|---|---|---|---|
| DF1.10 | (already `done`) | `done` | PR #216 (`081b21c6`) + #228/#229/#230 |
| DF1.11 | `ready-for-dev` | **`done`** | PR #232 `d7dcf8bf` + #233 `b88c13af` + #234 `589ecc3d` (DF1.11b) + #236 + #237 `fa7d0e26` |
| DF3.5 | `in-review` | **`done`** | PR #185 merged 2026-09-04T19:51Z (`06f455a3`) |

Meta counter recomputed from per-story entries: **30/37 stories, 125/151 pts**
(cross-check: the seven not-done stories sum to 26 pts; 151 − 26 = 125).

---

## The substrate these specs must now be read against

Restoration arc per the ADR — 3 of 5 landed:

| # | Story | State | What it means for the seven |
|---|---|---|---|
| 1 | DF2.10 factory-owned boot image | ✅ | digest-pinned image; bun + pi ELF + catalog in-image; `--image`/`--registry-auth` threaded |
| 2 | DF1.10 in-box phase engine | ✅ | engine walks **in-box**; `dispatch_task` resolves `file:"bun"`; resident solicited in-box off the **single** capped key at `$HOME/app/.env`; marker at `/run/journal/final.json`; harvest tar carries trace.db + journal + resident artifacts |
| 3 | DF1.11 steering executor + channel lifecycle | ✅ | inbox drained / acks written **on-box**; `/etc/tmpfiles.d/qds-steering.conf` recreates `/run/steering` at boot; boot-anchor row per engine start |
| 4 | **DF3.7** approval-gate bridge | ⬜ in this campaign | writes the awaiting marker in-box; host polls; gate stays host-owned |
| 5 | **DF3.8** host completion watcher | ⬜ in this campaign | the story that makes "unattended" true |
| + | **DF3.6** resident bounds | ⬜ in this campaign | ADR §Consequences.5 — "its in-box clauses become correct again; re-sequence after the engine story" |

Live e2e coverage that now exists (23 files, 5 tiers): `tier1-*` (8), `tier2-{dispatch-engine,
fanout-bestofn,image-contract,attach-transport,in-box-engine,reboot-arm}`, `tier3-{race,
manystories,expose-port,reaper,remote-phases}`, `tier4-resident`, `tier5-gate-steering`.

---

## Dependency-pairing plan (Rule 1)

Load-bearing contracts drive the split. One agent owns **both halves** of a contract so
writer↔reader drift is caught in a single context.

| Agent | Owns | Contract that justifies the pairing |
|---|---|---|
| **A** | DF3.7 + DF3.8 | DF3.8 `deps: [DF1.10, DF2.6, DF3.1, DF3.7]`. DF3.7 **writes** the in-box awaiting/completion marker; DF3.8 **reads/polls** it host-side. Classic writer↔reader. Both also extend `src/fleet/approval-gate.ts` + `status.ts` + the `fleet` CLI. |
| **B** | DF5.3 + DF5.4 | DF5.4 `deps: [... DF5.3 ...]` — DF5.3 **emits** the extended audit links (credential/box/bundle/re-verify); DF5.4's lights-on gate **asserts** them on the P0.11 gate chassis. Shared audit-record schema + shared gate chassis. |
| **C** | DF3.6 | No load-bearing sibling among the seven — its contract partners (DF1.10, DF1.11, DF2.3, DF2.8, DF3.3) are all **shipped**. Solo, read against code. |
| **D** | DF6.1 | Deps all shipped (DF5.2). 489 lines / 6 pts — the largest and the most likely re-split candidate. Solo. |
| **E** | DF5.5 | The repoint chore: its "contract" is with *every* other story file + `sprint-status.yaml`. Solo by necessity — it is the one story whose edits would collide with the whole campaign, so it is scanned in parallel but **fixed last**, after all sibling story files are final. |

**File-collision invariant (Rule 2):** no two parallel agents own edits to the same file. A
paired agent edits its two files sequentially. DF5.5's fix wave is serialized after all others.

---

## Wave progress

| Wave | What | Status |
|---|---|---|
| Dependency analysis | pairing plan above | ✅ DONE |
| Initial scan | 5 paired/solo adversarial reviewers | ✅ DONE — 135 findings |
| Wave 0+1 | cross-cutting themes + all 33 BLOCKERs (merged: cross-cuts locked in each prompt, files owned exclusively) | ✅ DONE |
| Wave 2–4 | HIGHs + MEDIUMs + LOWs, consolidated per agent (agents resumed in their own contexts via SendMessage, not respawned) | ✅ A, B, D, E · 🟡 C |
| Wave 5 | fresh-eyes verification (5 verifiers, uncoupled from fixers) | ✅ DONE — **125 findings** |
| Wave 5b | re-fix verification BLOCKERs/HIGHs (25 B + 40 H) | ✅ DONE |
| Wave 5c | re-fix verification MEDIUMs/LOWs (43 M + 22 L) | ✅ DONE — zero deferrals except one owner-named |
| Wave 6 | THIRD independent verification (convergence test) | ✅ DONE — **90 findings; VERDICT: NOT CONVERGED** |
| Wave 7 | seam-ownership rework (5 unit tables, 9 specs reconciled) | ✅ DONE — merged via PR #255 |
| Wave 8 | fresh verification of the reworked specs | ✅ DONE — **48 findings; NOT CONVERGED** (1 of 9 stories) |
| Wave 8 fix | all 48 findings applied in-session (429 fallback) | ✅ DONE — consistency gate green after every unit |
| Wave 9 | fresh verification post-fix-wave | ✅ DONE — **48 findings; VERDICT: NOT CONVERGED** (2 of 9 CONVERGED) |

## Wave 6 result — the count fell, the category did not. VERDICT: NOT CONVERGED.

Five fresh verifiers, none briefed with a fix recipe, each asked to classify every finding by
**category** rather than only by severity. The category distribution is the result; the count is not.

| Verifier | B | H | M | L | Total | C1 cite | C2 semantic | **C3 structural** | C4 marginal |
|---|---|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 0 | 2 | 7 | 6 | 15 | 4 | 3 | **5** | 3 |
| B (DF5.3+DF5.4) | 0 | 4 | 7 | 5 | 16 | 5 | 2 | **6** | 3 |
| C (DF3.6a+DF3.6b) | 4 | 5 | 6 | 2 | 17 | 4 | 5 | **7** | 1 |
| D (DF6.1a+DF6.1b) | 1 | 8 | 5 | 6 | 20 | 3 | 5 | **9** | 3 |
| E (DF5.5+DF2.11/12/13) | 0 | 1 | 8 | 13 | 22 | 12 | 3 | **4** | 3 |
| **TOTAL** | **5** | **20** | **33** | **32** | **90** | **28** | **18** | **31** | **13** |

**Wave-over-wave: 135 → 125 → 90 findings; 33 → 25 → 5 BLOCKERs.** Read alone, that is convergence.
It is not. **C3-structural is the single largest class (31, 34%); C4-marginal is 13 (14%).** Convergence
means the residue is wording. The residue is structure.

Three of five verifiers returned NOT CONVERGED unprompted; E returned not-converged for DF5.5 and
**converged with high confidence for DF2.11, DF2.12 and DF2.13**; only DF3.7 came back near-clean.

### The third class, stated precisely

| Wave | Class | The defect |
|---|---|---|
| 0–4 | C1 | the spec points at the wrong place |
| 5 | C2 | the spec points at the right place, but that code never runs |
| **6** | **C3** | **the spec is not self-consistent at its own seams** |

C3 instances, all verified by the parent at source before ratification:
- **Work described by both halves of a pair and owned by neither.** `W6-D-B1` (BLOCKER): DF6.1a ends
  at "**Invocation 2 exits.**"; DF6.1b opens its 15-minute CI window "measured from `pushVerifiedSha`'s
  return", which happens *inside* invocation 2; DF6.1b's `scripts/fix-run.ts` "**adds only**" list
  enumerates five additions, none the poll call site, and closes "otherwise unchanged". `ci-status.ts`
  is declared and never called. Also `W6-B-H2` (no path seam for `.sandbox/reverify/`, so C9's
  subprocess resolves against the dev's real repo) and `W6-A-M5` (DF3.7's verb must take the run lock —
  stated in an invariant, owned by no AC, DoD item or test).
- **Branches unreachable given the story's own specified ordering.** `W6-A-H1`: at the single
  observation point AC3 permits, the invocation has not yet read the marker, so `markerWitnessed` is
  false on every candidate and `completion-unwitnessed` fires 100% of the time — making DF3.7's
  `ChainOutcome.markerWitnessed` a contract field with no producer of `true`. Also `W6-C-B2`, `W6-D-H5`.
- **Residues rendered dead by dependency edges this campaign itself added.** `W6-A-H2`: DF2.11 ≺ DF3.7
  ≺ DF3.8 strictly, so DF3.8's entire "until DF2.11 lands" section is obsolete on arrival, including a
  `--help` warning marked temporary with no removal owner. Three artifacts state three different edge
  strengths.
- **Declared file scope forbidding the edits the ACs require.** `W6-D-H6`: the sole trigger has no
  owning module; `GitHubApi`'s four methods cannot list PR review comments and `src/pr/github.ts` is
  not in Files to Modify.

**The class is substantially iatrogenic.** The campaign cut two splits (DF3.6→a/b, DF6.1→a/b), added
three stories and re-pointed dependency edges. D's BLOCKER is orphaned work across a seam *this
campaign cut*. A's H2 is dead by an edge *this campaign added*. E's H1 is a meta block invalidated by
*this campaign's newest story*. C's BLOCKERs are the **third** wrong derivation of a number two prior
fix waves already rewrote. A fourth patch round would operate on specs whose defects are being
generated by the patching, and the iatrogenic rate is not falling.

### DF3.6a's spend ceiling — wrong a third time, same family (parent-verified)

The third derivation is arithmetically self-consistent and correctly fixed derivation 2's `Σ retries`
error. It is still wrong, one level down. The predicate (`df3-6a…:451`) is
`spent + projected > effectiveCeiling`, where `spent` is metered cumulative and `projected` is the
504 µ$ constant. The derivation (`:308`) computes the trip as `15 × 504 = 7,560; +504 = 8,064 > 8,000`
→ call 16 — charging `spent` at the *projected* rate. But `meter(reply.usage)` (`steering.ts`,
accumulator defined in the same function) sums **actual** usage; with the repo's own fake resident
(`tests/phase-engine/fixtures/fake-resident.ts`, default `{input:1000, output:64}` ≈ 92 µ$) the bound
binds near call **82**. Same family as derivations 1 and 2: a bound reasoned against a number the
running code does not accumulate that way.

**And the story contradicts itself about it.** `:65` — "the refusal is driven by the projection,
**never by metered spend**". `:451` — `spent + projected`. `:79` rejects comparing against metered
spend as the wrong fix, while the predicate already does so on its left operand. Patching the number
a fourth time cannot settle a disagreement the story has with itself about the metering basis.

### The citation discipline could not be held by the people who derived it

The campaign's convergent, three-times-independently-reached fix was **cite by symbol, not by line**.
Measured after adopting it: **505 line-citations remain across the twelve specs.** Machine-checked,
0 point at a missing file or past EOF — and that proves nothing, because commit `287c036c`
(this branch, one commit before the handoff) inserted a **net +26** hunk into `src/providers/credentials.ts`
and produced *two* wrong populations at once:

- **never updated (+26):** DF5.3 `:244`→270, `:144`→170, `:685`→711, `:261`→287; DF5.4 `:535`→561 ×2;
  DF5.5 `:261`→287.
- **updated from an eyeballed estimate (+6):** the commit's own docstring says *"the **twenty** lines
  it added pushed that call to `:281`"* — the hunk is `+27/−1 = net +26`, so the true location is
  `:287`. DF2.13, authored in the same commit from the same estimate, inherited the error across five
  citations.

The docstring's entire purpose is to warn against stale line citations. It says so explicitly — *"this
docstring managed to commit one about itself"* — and then commits a second one in the same sentence.
Three live generations of one wrong number (`:261`, `:281`, actual `:287`).

Separately: **49 citations use a bare basename that resolves to two real files in this repo.** Two
pairs are load-bearing — `report.ts` is *both* `src/reverify/report.ts` and
`src/phase-engine/gates/report.ts`, the two sides of R9's two-layer doctrine; `p1-19-…md` is both the
live phase-1 story and its `_archived/v4-paperclip-era/` copy, and DF5.5 is the repoint chore. Same
shape as the `redactSecrets` near-miss, in citation form.

### Slate, recomputed twice independently (parent + verifier E, agreeing)

**42 stories / 169 pts; 30 done / 125; twelve not-done / 44.** Per-epic DF1 10/45, **DF2 13/48**,
DF3 9/35, DF4 2/10, DF5 5/22, DF6 3/9. The `sprint-status.yaml` meta block still asserts 41/166,
"ELEVEN not-done", `df2 45` — stale by exactly DF2.13, including inside its own "recomputed from the
per-story entries" cross-check. DF5.5's E2E Slice and AC4 read the slate count *from that block*, so
the chore records a number its own source contradicts and every AC passes. **The handoff brief for this
wave says "eleven story specs" — the same off-by-one, in a fifth artifact.**

### The SEALED Wave-5 calibration was stale — both items had already been closed

Both withheld items were found and fixed by Wave 5 (`8f69a8ef`), and the outgoing session carried the
seal forward without re-opening the story:
1. `commentsDigest` is now defined **pre**-redaction, with the reproducibility argument written out —
   Wave 5 found it independently and **overruled the author's original call**.
2. DF6.1a AC1's locality control now has a proof mechanism: marker read through `readBoxFile`,
   `systemctl ExecMainStartTimestamp`, and a host process-table diff for `pi ` argv.

Wave 6 therefore had no calibration test from that seal. The measurement it was meant to provide was
instead supplied by Wave 6 itself: three of five verifiers overruled a prior wave's fix with evidence
(`W6-B-M5`, `W6-D`'s V-DF6.1b-B3 reversal, `W6-C`'s two 5b reversals — the latter confirming 5b was
right), and E overruled **this parent** on the DF2.13 citation offset.

### What Wave 6 says is READY

**DF2.11, DF2.12 and DF2.13 converged** (E, high confidence, each defect independently re-verified at
source: the reaper holds no lock; `CostLedger`'s constructor creates and `exec`s SCHEMA on every read;
nothing compares a minted cap to `defaultKeyCapMicroUsd`). These are also the three fixing live defects
in merged code. **DF2.13 being least-reviewed did not make it weakest.** Blocker on their DoDs only:
**PR #238 must merge first** — `scripts/lib/run-lock.ts` still carries raw NULs, so every
grep-authoritative DoD item over that file is unprovable, silently.

## Wave 7 — seam-ownership rework (2026-09-13)

Executed per the charter (`2026-09-10-wave7-HANDOFF.md` §4(ii)): NOT a fourth prose-patch round.
One **seam-ownership table per rework unit**, every deliverable/file/call-site/flag/AC/test listed
once with exactly one owner, then each spec reconciled to its table. Tables:
`seam-ownership/unit-{A,B,C,D,E}-*.md` — every Wave-6 finding (90) has a written disposition there
(fixed / deleted / ruled / verified-closed / out-of-scope-with-reason). The consistency gate was
run after each unit and stayed green; it also caught and fixed one pre-existing drift (DF2.13's
story header said `in-review` against a merged done-flip).

**Operator rulings landed this wave (both recorded in the specs they govern):**

1. **DF3.6a metering basis (resolves W6-C-B1): honest metered operand.** The engine accumulates
   `meter(reply.usage)` actuals; the pre-call refusal compares the *projected* next-call worst case
   (`spent + projected > effectiveCeiling`) — making the story's "refusal is driven by the
   projection" sentence true unambiguously; the post-call tripwire bounds the one-call overshoot a
   soft projection allows; AC1's journal assertion weakened to `ceiling + one call's metered cost`.
   The accumulator is the same quantity DF2.12's landed token rows record — one spend truth,
   auditable at DF5.3 hop 3. **No binding call count is derived** — three derivations died deriving
   one; what is pre-checked is reachability (AC6), what is enforced is the refusal.
2. **DF3.6a ceiling basis (resolves W6-C-B3): user policy, not a derivation.** A spend amount the
   user sets — a global default applying to all repos/projects/tasks, plus a per-task custom
   override. Ladder at fill: `perIssueOverrides` entry (the factory substrate's per-task seam, the
   one DF2.13's `--cap` uses; a factory UI is a future product story — no new surface invented
   here) → user-set config default → shipped **fallback** 8,000 µ$ (documented as a fallback for
   cheap rosters, never as a derivation). `below_one_call` stays as the typed refusal when the
   configured amount cannot buy one projected call — a named policy outcome (subsumes W6-C-L2).

**Structural decisions taken under the charter's fix directions (all written into the unit tables):**
W6-A-H1 resolved by **deletion** (option b — `markerWitnessed` had no producer of `true`; a
collected record is always `completion-unwitnessed`); W6-A-H2 resolved to the **one true reading**
(DF2.11 landed → hard predecessor everywhere; the temporary `--help` reap warning deleted; the
`run-lock.ts` ponytail-note retirement owned by DF3.8); W6-B-H1..H4 closed as **one gap** (the
frozen fixture reaching outside itself: PR body frozen, four path seams on `qds-audit.ts`, the
audit store's no-create opener, `harvestRun` joining the required-seam list); W6-D-B1 resolved by
**naming the invocation** (invocation 2 continues into DF6.1b's poll leg before exiting — the
window anchors inside it); W6-D-H1's parent-run lookup re-keyed on the **head branch**
(`qds/<parentRunId>`, the zero-cost join); W6-D-H2's ceiling check re-homed to
`feedback-run.ts` (`fix-ceiling-insufficient` — the fan-out primitive's code cannot fire on a
single dispatch); W6-D-H3's fence restated at **symbol level**; W6-C-B4's trigger made producible
(**two-leg live proof**: synthetic allocator as the leg's `QDS_PI_BIN` at ~zero spend proves the
kernel kill; the real solicitation proves attachment).

**Parent-owned edits this wave:** yaml rows DF3.7/DF3.8 prose rewritten against merged text
(W6-A-M7); `DF2.11` added to DF5.3's deps (W6-B-M8); `DF2.13` added to DF3.6a's deps (W6-C-M4);
DF2.13 header flipped `in-review` → `done` (factual, git-verified). Verified closed at source:
DF2.13's epics-index entry exists (W6-E-M3 — grep → 1, control → 16); df3-6a's "at the dispatcher"
framings accurate post-DF2.12 (W6-E-M7). Out of scope with reason: all Wave-6-E findings on
DF2.11/DF2.12/DF2.13 (done stories; charter §8).

**Line-citation discipline:** baseline 407 file-anchored line citations across the nine specs; no
new ones introduced (gated). Wave 8 follows: five fresh verifiers, no recipes, category
classification, convergence target C4-dominant.

## Wave 8 result — five fresh verifiers over the reworked specs (2026-09-13)

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave8-{A,B,C,D,E}-*.md`. Fresh eyes,
no recipes, no prior-wave evidence read; every claim source-verified with positive controls.

| Unit | Wave 6 | Wave 8 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 15 | 12 | 0 | 1 | **0** | 2 | **DF3.7 CONVERGED** (high) · DF3.8 NOT (high) |
| B (DF5.3+DF5.4) | 16 | 8 | 0 | 0 | **0** | 3 | both NOT (medium-high) |
| C (DF3.6a+DF3.6b) | 17 | 12 | 0 | 3 | 2 | 4 | both NOT (high) |
| D (DF6.1a+DF6.1b) | 20 | 8 | 0 | 1 | 3 | 3 | both NOT (high) |
| E (DF5.5) | 22* | 8 | 0 | 0 | 3 | 1 | NOT (high) |
| **TOTAL** | **90** | **48** | **0** | **5** | **5** | **13** | 1 of 9 stories CONVERGED |

*E's Wave-6 count includes 13 DF2.11/12/13 findings retired as done-story out-of-scope in Wave 7.

**Campaign verdict: NOT CONVERGED — but the class moved.** BLOCKERs 5→0, HIGHs 20→5, C2 18→5,
C3 31→13, total 90→48. Unit A's zero-C2 result is the Wave-6 lesson landing: "every mechanism
claim held — the residue is address accuracy." The rework killed the seam class it targeted; the
48-finding residue is enumerated in the five wave8 reports (point at the report, never relay), and
its load-bearing core is small:

- **W8-C (3 HIGH, C3):** DF3.6a's three stamped operands have **no owned fill-side provisioner**
  (dispatch stamps `limitMicroUsd` only — every real resident run would refuse while
  hand-authored-fixture suites stay green); DF3.6b's mandatory live legs are sited on
  `tier4-resident`'s **darwin host-side file**, where the story itself concedes cgroups cannot
  exist; DF3.6b AC4's stop/record outcome is unreachable under the pair's own closed edit list.
- **W8-D (1 HIGH, C3):** the attempt-2 driver's attempt-state lookup reads
  `fixOutcome.runIds`, which by the write-once/terminal-only contract does not exist after a
  charged attempt-1 failure — **no one owns a dispatch-time parent-record write**.
- **W8-A (1 HIGH, C3):** DF3.8 AC4(d)'s cross-pass retirement contradicts the sweep's own
  no-persistence/single-pass invariant. Plus the exit-5-vs-AC6 wording split (MEDIUM).
- **W8-B (C3 MEDIUM):** the F001/#157 "declared, not wired" premise is **inverted — DF2.12 landed
  and wired the bridge**; both DF5.3 and DF5.4 (and DF6.1a's observability bullet) need the
  honest post-DF2.12 state. C3's "merged envelope" names no harvested artifact.
- **W8-E:** one C3 + one C2 MEDIUM, both narrow (see report).

**Next: fix wave on the 48 (reports carry the fix directions), then Wave 9 fresh verify.**
Convergence target unchanged: C4-dominant residue.

## Wave 8 fix — all 48 findings applied in-session (2026-09-14)

Executed by the parent session (the five parallel fix agents died pre-edit on provider 429s —
weekly limit, resets 2026-09-17 — so the work ran sequentially in-session, same protocol: every
finding verified at source before editing, fixers pointed at report sections). All 48 findings
across the five wave8 reports dispositioned; the consistency gate was green after every unit.

**The load-bearing fixes:**
- **W8-C-1 (HIGH):** DF3.6a gains the fill-side stamp provisioner it mandated but never owned —
  an adds-only edit to the dispatch fill step in `src/fleet/dispatch.ts` (DF3.1-owned file,
  DF5.3 setup-gate precedent), stamping the three bound operands onto the frozen manifest.
  Ownership rows O20/O21 added to `seam-ownership/unit-C-df3-6ab.md`.
- **W8-C-2 (HIGH):** DF3.6b's two AC1 live legs re-sited off the darwin host-side
  `tier4-resident` file onto a dedicated in-box dispatch (`fleet run` under `qds-run@.service`,
  the tier2-in-box pattern), second dispatch named, baseline `memory.peak` sourced from that
  round's own control solicitation; costs corrected (~401 µ$ measured, two boxes).
- **W8-C-3 (HIGH):** pipeline-run edit (v) widened to the exit-97 `unenforceable` classification;
  the failed-solicitation record's emitter and destination named (fleet `warn` chokepoint,
  harvested via fd-2) — mirrored in both halves' Files lists.
- **W8-D-1 (HIGH):** the attempt-state lookup re-grounded on an owned **attempt-time ledger**:
  DF6.1b registers `fixAttemptRunIds: "strings"` on the parent record's `fixLoop` namespace (the
  first-class array DF5.3 anticipated), appended at each attempt's dispatch — so it exists
  pre-terminal, unlike `fixOutcome`. Lookup = parent join → ledger's last entry → fix run's own
  record. Ownership rows O15 (extended) + O22 added to `seam-ownership/unit-D-df6-1ab.md` (the
  O5 pattern: DF6.1b's logic invoked from DF6.1a's invocation).
- **W8-A-1 (HIGH):** DF3.8 AC4(d)'s retirement scoped **in-pass** — nothing persisted; a later
  tick re-enumerates and re-refuses, counted and reported each time, the same per-tick fate as
  the reboot arm.
- **Post-DF2.12 premise inversions fixed everywhere they were asserted** (W8-B-1, W8-D-3):
  DF5.3 AC5/hop-3/DoD, DF5.4-C10, both DF6.1 Observability Contracts now state the wired bridge
  (`ingestHarvestedTokensIfWired`, `hasTokenRows: true` on healthy runs); DF5.4's producer row
  also corrected (`fleet observe <run-id>`, not the out-of-scope `--await-completion` — found
  in-pass, unflagged by wave8).
- **W8-D-2:** `out-of-scope-diff` charges **zero** everywhere (DF6.1b's CI-reaching rule is
  canonical); its cap of 1 is the third, deliberate vocabulary, owned by DF6.1b.
- Cite-rot (W8-A-3..9, W8-B-3/4, W8-C-6, W8-D-6, W8-E-5/6): stale/wrong line citations replaced
  by symbol or section anchors per the campaign's cite-by-symbol law; verified-exact cites kept.
- W8-A-12: the sweep's event renamed `sweep-box-unreachable` (O15 updated).

**Extra fixes beyond the worklist (recorded per open-the-file rule):** DF5.4 producer-row
trigger (above); DF6.1a AC6 `out-of-scope-diff` charging aligned (part of W8-D-2's seam).

**Not done this wave:** no yaml edits owed (no new stories, no dep-edge changes); tracker
untouched except this section. **Next: Wave 9 — five fresh verifiers, no recipes, no prior
reports, C1/C2/C3/C4 classification, per-story verdict. Target: C4-dominant residue.**

## Wave 9 result — two stories crossed, the fix wave opened two seams. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave9-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only, no recipes/tracker/tables/prior reports; every load-bearing finding
parent-verified at source before this entry.

| Unit | Wave 8 | Wave 9 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 12 | 10 | 0 | 0 | **0** | 1 | DF3.7 NOT (high) · **DF3.8 CONVERGED** (high) |
| B (DF5.3+DF5.4) | 8 | 8 | 0 | 0 | **0** | 2 | both NOT (high) |
| C (DF3.6a+DF3.6b) | 12 | 15 | 1 | 2 | 4 | 4 | both NOT (high) |
| D (DF6.1a+DF6.1b) | 8 | 11 | 1 | 2 | 2 | 4 | both NOT (high) |
| E (DF5.5) | 8 | 4 | 0 | 0 | **0** | **0** | **DF5.5 CONVERGED** (high) |
| **TOTAL** | **48** | **48** | **2** | **4** | **6** | **11** | **2 of 9 CONVERGED** |

Per-class: C1×15 · C2×6 · C3×11 · C4×16 (B2/H4/M10/L32). Unit A: C1×3/C3×1/C4×6 ·
B: C1×2/C3×2/C4×4 · C: C1×3/C2×4/C3×4/C4×4 · D: C1×5/C2×2/C3×4 (no C4) · E: C1×2/C4×2.

**Campaign verdict: NOT CONVERGED — the convergence target (C4-dominant residue) is unmet.**
C4 is now the largest single class (16), and DF3.8 + DF5.5 crossed with zero B/H/C2/C3 — but
BLOCKERs went 0→2 and both sit on **seams the fix wave itself opened or touched**:

- **W9-D-1 (BLOCKER, parent-verified):** DF6.1a's invocation-2 resolution (AC3, Overview,
  "Wiring closed") reads DF6.1b's `fixAttemptRunIds` ledger, but `EXTENSION_NAMESPACES.fixLoop`
  registers only `fixContext`/`fixOutcome` (`src/providers/run-record.ts:219`), the registration
  is DF6.1b's adds-only edit, DF6.1b is sequenced after, and DF6.1a's own Files list says
  `run-record.ts` "**no change expected**" while claiming buildability "using only code merged by
  this story plus its predecessors". Read-path tolerance for unfamiliar fields in a registered
  namespace means no runtime crash — this is an ordering/testability seam, not a live failure —
  but the load-bearing AC is untestable at the half's own merge point with contradictory same-file
  postures. Cross-ref **W9-D-3 (MEDIUM C3)**: no half owns the attempt-1 ledger append (DF6.1b's
  `fix-run.ts` edit list names only the read), so AC2's populated-ledger precondition is
  unreachable — the O22 pattern's append half was never given an owner.
- **W9-D-2 (HIGH, C3):** the uncharged-attempt ceiling of 3, the per-attempt classification list,
  and `out-of-scope-diff`'s cap of 1 mandate per-attempt classification **storage** that no
  declared state can hold: the record vocabulary is closed, the ledger holds runIds only,
  `fixOutcome` is write-once-at-terminal, and a `dispatch-refused` attempt ("provisions nothing")
  never reaches the ledger. The charged ceiling is derivable; the uncharged one is not. AC2's
  "escalates immediately" also contradicts the DoD's accumulate-three reading.
- **W9-D-4 (HIGH, C3):** DF6.1a AC2's proposal-variation trigger ("when the run carries a
  `fixContext` brief key") is unobservable in `src/reverify/runner.ts` — zero brief references;
  the brief is consumed in-memory in `dispatch.ts`, never persisted host-side; `fixContext` is
  written only after `pushVerifiedSha`, i.e. after `requestApproval` (`runner.ts:461-462`,
  hard-coded proposal) has already fired.
- **W9-C-1 (BLOCKER, parent-verified):** DF3.6b's make-or-break observable
  `resident.exitStatus:"overflow"` is clobbered by the shipped final refresh in
  `scripts/pipeline-run.ts` (`residentBlock.exitStatus = await residentSpawn.exitStatus()` —
  "keep null — the process's word is telemetry"), and `resident.ts`'s `lastExit` is only ever
  `"success"`/`"transient"`/`"logic"` (zero `"overflow"` hits; kernel OOM signal death →
  `"transient"`). None of the pair's six enumerated `pipeline-run.ts` edits touches the refresh —
  the mandated observable is unreachable under the story's own closed edit list.
- **W9-C-2 (HIGH, C3):** DF3.6a AC2a's refusal payload `{ ok:false, code, message, remediation }`
  cannot be written "through the existing marker writer" — `writeTerminalMarker` hard-codes
  `{runId, ok, completedAt}` and `journal.ts` is absent from the Files list; the ≥4096-byte
  `unknown`-verdict arm is an unacknowledged adjacent risk. **W9-C-3 (HIGH, C3):** DF3.6b AC4's
  exit-97 `unenforceable` classification has no detection channel — the seam enumeration ("three
  facts cross, on two objects") carries no unenforceable signal; `lastMemory()` yields
  `oomKilled` only and the caller boundary delivers an opaque redacted `Error`, so the engine
  cannot classify and the mandated stop+record never fires.
- **W9-B (2 C3 MEDIUM):** `recordAuditLink`'s required-vs-optional seam (optional signatures
  cannot deliver the typecheck-loudness guarantee); the hop-6 refs/sandbox leg has no seam in
  qds-audit's four-flag CLI (shared with DF5.4-C9, counted once).
- **W9-A (1 C3 MEDIUM, parent-verified):** DF3.7's "eighth `teardownSandbox` call site" claim is
  contradicted by DF2.11's own record, which assigns the eighth to DF3.8's sweep.
- **C2 residue (6):** D's inherited DF13 briefing still says the fleet-ceiling race was
  "Re-verified TRUE at `fa7d0e26`" — false; closed by `99f591e3`, a verified ancestor
  (`git merge-base --is-ancestor`). C's DoD-mirror "gate fails every attempt → stops at the
  fourth point, next phase solicits" is unreachable (`attempt > spec.retries` rethrows — the
  phase fails; AC3's own prose is correct, the DoD regressed to the Wave-5b defect); C's AC4
  projection-charging is unspecified on the DF2.12 attribution row; C's AC5(b) log-line clause is
  unreachable (status gate precedes the bounds check for a degraded resident); C's Leg A delivery
  channel is unnamed (a synthetic allocator as **that leg's `QDS_PI_BIN`** on the in-box dispatch
  needs a named route — the engine's process env is read in-box and DF2.10's AC6 image scan admits
  exactly two `QDS_` directives); D's escalation
  vocabulary omits `scope-requires-privilege` and `bot-response-to-fix`.

**What held (per reports' positive-verification sections):** unit C re-derived the entire demo
arithmetic exactly (760,960 µ$ projection, refusal at pgf#2, harness-kill precedence) and verified
the cap chain, `steering.test.ts` 91/0; unit D verified every redaction, record-schema, push/lock
and approval claim exact with positive controls on all absence claims; unit B found every chassis
anchor, budget figure and negative control sound; unit E found all 28 occurrence lines and all
amendment anchors exact.

**Parent corrections to agent reports (recorded per open-the-file law):** unit C's summary-count
table miscounts 6b LOWs as 3 (the findings table lists 4; pair = B1/H2/M3/L9, classes
C1×3/C2×4/C3×4/C4×4 — the table above uses the corrected figures); unit C's W9-C-3 evidence
clause "later solicitations keep issuing into the broken placement" is wrong — the status gate
treats a degraded resident as absent, so no further calls are issued; the finding's substance
(no `onBoundBreach` channel ⇒ no stop, no record) stands.

**Operational note (verifier E, parent-owned):** the yaml meta block's DF totals were stale at
wave-9 time (claimed 37 stories/151 pts; live rows recount 42/169) — DF5.5's DoD recompute-and-halt
gate would fire at pre-flight by design. **Fixed 2026-09-14 (PR #255 review round):** the meta
block lead now carries the recounted 42/169 figures (per-epic and per-sprint-tag reconciliation
recounted from the rows in the same edit); not a spec defect.

**Next: fix wave on 2 BLOCKER + 4 HIGH + 6 C2 + 11 C3** (B rates its two C3s one-sentence fixes;
D's BLOCKER resolves if DF6.1a owns registration + dispatch-time append and both halves'
same-file postures reconcile; C's BLOCKER needs the final refresh in an enumerated edit), then
**Wave 10 fresh verify**. Target unchanged: C4-dominant residue.

## Wave 9 fix — all B/H/C2/C3 findings applied or verified-applied in-session (2026-09-14)

Executed by the parent session, sequential in-session A → B → C → D (the Wave-8 precedent:
parallel fix agents die pre-edit on provider 429s), same protocol: every finding verified at
source before editing, fixers pointed at report sections, self-proving greps, the consistency
gate green after every unit. **Several findings were already fixed post-wave-9 by the PR-#255
CodeRabbit rounds on this branch — verified at source, not redone**: W9-D-1 (DF6.1a owns the
`fixAttemptRunIds` adds-only registration + dispatch-time append, forward-dependency note in its
Files list, commit `e6f5db3d`), W9-D-2 (per-attempt lifecycle states derived on the driver's read
from the fix run's own record in arm order; `dispatch-refused` resource-bearing but excluded from
the accumulate-to-3 ceiling), W9-D-3 (append owner = the same DF6.1a row), W9-C-3 (exit-97
`unenforceable` crosses as an engine-owned typed rejection; `onBoundBreach` fires with the
classification; the runner's edit-(v) arm records on the fleet `warn` chokepoint), and unit A's
only C3 (DF3.7 now claims no `teardownSandbox` ordinal, citing DF2.11's record — `e6f5db3d`).

**The load-bearing fixes applied this wave:**
- **W9-C-1 (BLOCKER, closed):** the pair's `pipeline-run.ts` edit list grows six → **seven** —
  edit **(vii)**, the run-down refresh precedence: the final telemetry refresh keeps the engine's
  `exitStatus:"overflow"` and fills the process-probe word only when the engine wrote none. The
  probe's `lastExit` vocabulary is `success`/`transient`/`logic`, never `"overflow"` (verified at
  source), so without the edit AC1's make-or-break journal observable is clobbered to
  `"transient"` on a kernel OOM-kill. Count and (vii) mirrored in both halves' Files lists;
  ownership rows O6/W6-C-M2 updated (`seam-ownership/unit-C-df3-6ab.md`).
- **W9-C-2 (HIGH, closed by re-siting):** AC2a's refusal keeps the marker in the writer's shipped
  shape — `ok:false` is the whole `fleet status: not-ok` observable — and the typed
  `{code, message, remediation}` triple moves to the engine's fd-2 diagnostic line; `journal.ts`
  stays unowned, and the 4096 interaction is now stated (a full `remediation` inlined into the
  marker risks `MARKER_MAX_BYTES`'s oversized arm, which reads as `unknown`, not `not-ok`).
  Mirrored in AC2a, DoD edit (i), and the DoD config-refusal test item.
- **W9-D-4 (HIGH, closed by re-siting):** the proposal-variation trigger moves off the unobservable
  `fixContext` brief key onto a **mint-time `fixRun: "string"` marker** on each fix attempt's own
  record (`extensions.fixLoop.fixRun = "true"`, written by DF6.1a's dispatch before the chain
  runs; same adds-only registration edit, O22 extended). `runner.ts` already holds the record at
  approval time (its `store.get(runId)` read precedes `requestApproval`), so the variation reads a
  value in hand — no new I/O, "no other behavior changes" intact.
- **W9-B (2 C3, closed):** W9B-1 was already resolved at source (the scope note and driver
  paragraph now say `required` everywhere — `recordAuditLink` required on the four `*Deps`
  interfaces, required on `provisionAdmittedRun`'s options, trailing required on `fillRun`);
  W9B-2 resolved by declaring hop 6's decisive evidence the bundle + its `bundle-verify` link row
  (sufficient alone — the walker carries no git-dir seam and never resolves a ref), with
  `refs/sandbox/<run-id>` corroborating only, identity asserted by DF5.4-C5 through the frozen
  fixture's bare `refs.git`; mirrored in the Reconstructable definition.
- **C2 residue (6, all closed):** DF6.1a-3 — the inherited DF13 briefing's "Re-verified TRUE at
  `fa7d0e26`" rewritten: the race was closed by `99f591e3` (re-verified ancestor via
  `git merge-base --is-ancestor`); the old red-by-design pin no longer exists; the surviving half
  (`FleetLock` single instantiation, per-run lock framing) kept. C's DoD-mirror unreachable
  trigger aligned to AC3's prose (fails 1–4, passes 5); the every-attempt case named as the
  `GateFailureError` phase failure. C's AC4: the projection charge is ceiling-side only; DF2.12's
  attribution row keeps the metered disposition — one spend truth **per basis**, and the
  "same quantity" sentence inverted accordingly. C's AC5(b) log-line clause reworded as
  belt-and-braces (the mechanism guarantees no post-latch bound evaluation exists); DoD test
  updated. C's Leg A: the allocator's `QDS_PI_BIN` route named — the leg's dispatch writes it into
  that box's `/home/exedev/app/.env`, the unit's mandatory `EnvironmentFile=` (box-local, never
  image content, outside DF2.10's baked `QDS_` allow-list). D's escalation vocabulary gains
  `scope-requires-privilege` and `bot-response-to-fix`.
- **Unit C's remaining C3s:** AC3's trigger leg now names its catalog (the default pi catalog —
  the frontier-priced slug stops the same fixture at the second point); AC4's ledger-side
  classification fixed as above.
- **In-pass extras (per open-the-file rule):** DF3.7 `unitActivity` param name (`timeoutMs`),
  `BoxFileRead` symbol cite, AC1 fence import-scoping wording; DF5.3 harvest-caller enumeration
  (three sites, the teardown-internal one flows through `TeardownDeps`), `createRun` callers
  (cap-hit-demo **and** approval-gate.test.ts), "file this story did not originally touch"
  narrative residue, six drifted `run-record.ts` cites → symbol cites, 8-char hash-prefix
  divergence remarked against the reaper's 12-hex precedent; DF5.4 `openReadOnly` read-path cites
  re-anchored to `src/providers/cost-ledger.ts::openReadOnly`; DF6.1a `review_feedback_detected`
  protocol-state claims corrected (webhook-era, no state machine), single-fixer roster line
  aligned with the shipped two-role yaml, the "survived seven review rounds" clause marked as
  this story's paraphrase (not an ADR quotation), two stale `fleet.ts`/`team-lead-driver.ts`
  cites → symbol cites; DF6.1b escalation vocabulary completed, stale `acquireRunLock`/
  `GATE_VERBS` cites → symbol cites (the `headRefName` fetch was already fixed by the CodeRabbit
  rounds — verified).

**Not touched:** DF3.8 and DF5.5 (converged). **Next: Wave 10 — five fresh verifiers, one
message, scope files only, no recipes/prior reports/tracker/tables. Target unchanged:
C4-dominant residue.**

## Wave 10 result — the class fell again; one BLOCKER remains, on the pair's own seam. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave10-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only, no recipes/tracker/tables/prior reports; blocking findings parent-verified at
source before this entry.

| Unit | Wave 9 | Wave 10 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 10 | 8 | 0 | 0 | 4 | **0** | both NOT (high) |
| B (DF5.3+DF5.4) | 8 | 8 | 0 | 0 | **0** | 1 | DF5.3 NOT (high) · **DF5.4 CONVERGED** (high) |
| C (DF3.6a+DF3.6b) | 15 | 12 | 0 | 0 | 2 | 1 | both NOT (0.8/0.85; pair seam 0.9) |
| D (DF6.1a+DF6.1b) | 11 | 11 | **1** | 0 | 3 | 1* | both NOT (0.7/0.9) |
| E (DF5.5) | 4 | 8 | 0 | 0 | 3 | **0** | NOT (high) |
| **TOTAL** | **48** | **47** | **1** | **0** | **12** | **3** | **1 of 9 CONVERGED** |

Per-class: C1×14 · C2×12 · C3×3 (+1 counted under C2) · C4×14 (B0/H0/M15/L30).

**Campaign verdict: NOT CONVERGED — BLOCKERs 2→1, HIGHs 4→0, C3s 11→3(+1), C2s 6→12.**
The severity classes collapsed onto the seam classes: what remains is contradictions and
ownerless state, not broken mechanisms. Both formerly-converged stories (DF3.8, DF5.5) were
re-opened by fresh eyes — the protocol working as designed.

**The one BLOCKER (parent-verified at source):** **DF6.1b-W10-1** — the attempt ladder's
terminal arm reads "the fix run's record **carries a terminal outcome classification**", but no
registered field can hold one (`fixLoop` = `fixContext`/`fixOutcome` only, `run-record.ts:219`;
`fixOutcome` is parent-record-only, write-once-at-terminal, outcome ∈ `green|escalated`), and
neither half's closed edit list adds one — charged/uncharged/dispatch-refused underivable on
read, and `poll-interrupted` byte-indistinguishable from a completed charged failure. Remedy
(verifier-offered, parent-selected): DF6.1a's adds-only registration grows a third field
(`fixOutcomeClass: "string"`, written by DF6.1b's terminal transition — the same-lock write the
story already specifies — read by arm 1), which also resolves the SEAM-1 "no change expected"
letter violation.

**Unit blocking sets (all parent-verified or one-clause):**
- **A:** DF3.7-A1 (C2) — AC5 routes every `reverify()` `approval: null` into `gate-refused`, but
  the shipped runner returns null from three non-gate arms (`nothing-to-verify` :291, the
  non-green verdict :421 — AC2(c)'s own legitimate veto — and the flagged catch :474; docblock:
  "null on a red/error verdict"); a red run would take a misattributed cause + teardown
  remediation on a closed record. DF3.8-A1 (C2) — `run-engine-dead` sits in the sweep's own event
  vocabulary **and** the inherited "every event DF3.7's module emits" clause: one dead run, two
  differently-shaped lines, vs AC4(d)'s once-per-pass (the `sweep-box-unreachable` rename
  precedent applied to box-unreachable but not engine-dead). Plus DF3.7-A2 / DF3.8-A3 C2 LOWs
  (untyped `closedAt` refusal code; seconds/millis mix in the Technical-Notes lag restatement).
- **B:** W10B-1 (C3) — the required-`recordAuditLink` threading breaks `scripts/cap-hit-demo.ts`
  and ~11 test files (~20 files reference the interfaces; verified by grep), but the Files list
  owns no fake/test entries and claims fakes are "already listed". W10B-2 (C1 MEDIUM, **the fix
  wave's own error**) — the corrected harvest-caller sentence says the two script-level sites do
  not flow `TeardownDeps`; at source all three do (`fleet.ts` `const tdeps: TeardownDeps`,
  `sandbox-teardown.ts` `const deps: TeardownDeps`, `teardown.ts`'s internal step). DF5.4
  CONVERGED (its W10B-8 is C4: shared-scratch-copy wording).
- **C:** W10C-PAIR-1 (C3) — the seven-edit list double-claims `lastMemory` (6a edit (ii) vs 6b
  edit (iv); pre-existing, not introduced by (vii)). W10C-6a-2 (C2) — the ceiling ladder's rungs
  1–2 have no carrier (`CostConfig` closed at three keys; `cost-ledger.ts` unlisted; "no new
  surface invented here"). W10C-6b-1 (C2) — nothing sets `telemetry.status` on the unenforceable
  path (the stopped-writer is oomKilled-gated; `stop()` writes no telemetry), so the next
  solicitation passes the gate and the latch throw re-degrades — recreating the misclassification
  edit (v) exists to prevent. W10C-6a-1 (C1, **the fix wave's own wording**) — AC4's ledger-side
  label "priced-zero" is wrong against shipped `emitResidentAttribution` (records **unpriced**,
  `unpricedTurns=1`).
- **D:** the BLOCKER above; DF6.1a-W10-1 (C2) — INV-7's "validate-only mode" names a store API
  the shipped surface does not expose (`assertNoSecret`/`assertKind` unexported; the fence permits
  only `RunRecordStore`/`RunRecord`) — route: a scratch store in a temp dir through the permitted
  constructor, or scope validation to the fixloop parser; DF6.1b-W10-2 (C2) — `orphaned` missing
  from the escalation-classification enumeration.
- **E:** W10E-1 (C2) — amendment C's `p1-5` text and amendment D's `p0-7` blockquote prescribe
  insert text without the load-bearing `v5 amendment (DF5.5)` marker (`p1-5` is boundary-only, so
  verbatim pasting yields 10 marker paths, not the declared 11 — AC1 fails). W10E-2 (C2) — the
  provenance negative control routes to "assertion (2)'s provenance arm", an arm the
  four-assertion enumeration never defines. Plus 1 C2 LOW (yaml row comment narrower than the
  canonical set). Both C2s parent-verified true at source.

**Parent corrections to verifier messages (open-the-file law):** none this wave — every
load-bearing claim spot-checked landed (runner.ts null arms, `fixLoop` registration, DF3.8 event
vocabularies, harvestRun `TeardownDeps` flow, amendment C/D marker absence, ladder arm-1 wording
verbatim).

**Next: Wave 11 fix wave** on 1 BLOCKER + 12 C2 + 3 C3 (all one-clause to one-paragraph fixes;
D's BLOCKER completes an existing design sentence rather than redesigning), sequential in-session
A→B→C→D→E, then **Wave 12 fresh verify**. Target unchanged: C4-dominant residue.

## Wave 11 fix — every BLOCKER/C2/C3 finding applied in-session (2026-09-14)

Sequential in-session A→B→C→D→E, same protocol; the consistency gate green after every unit.

- **The BLOCKER (DF6.1b-W10-1, closed):** DF6.1a's adds-only registration grows to **three**
  fields — `fixOutcomeClass: "string"` joins `fixAttemptRunIds`/`fixRun` on the `fixLoop`
  namespace — and DF6.1b's terminal transition (the same-lock write the story already specified)
  is named as its writer; the ladder's terminal arm now reads the registered field instead of the
  carrierless "terminal outcome classification" phrase. Charged/uncharged/dispatch-refused are
  derivable on read; `poll-interrupted` (fixContext + no `fixOutcomeClass`) is distinguishable
  from a completed charged failure. DF6.1b's `run-record.ts` Files line rewritten from "**no
  change expected**" to "registration read, not made" — also resolving W10-D-SEAM-1's
  letter violation. O22 extended.
- **Unit A:** DF3.7's `gate-refused` arm scoped to a null **on a `green` verdict**; the three
  non-gate null arms (non-green verdict, `nothing-to-verify`, approval-request catch) get a new
  truthful `ChainOutcome` arm — `{ kind: "vetoed"; reason }`, same post-chain exit 6, never a
  teardown remediation on a closed record — mirrored in the union, the Observability `kind` list,
  AC5, and the DoD test + negative controls. The mandated `closedAt` refusal named:
  `{code: "run-already-closed"}`, exit 5. DF3.8's sweep line renamed **`sweep-engine-dead`** (the
  `sweep-box-unreachable` treatment applied to the second dual-vocabulary name), rationale
  mirrored in AC4(d)/exit-table/Observability/DoD, O15 extended; Technical-Notes lag restated in
  `uptimeMs`; AC1's fence enumeration gains the barrel limb + the DoD Security box "first four"
  fixed. F106's "as DF5.1 scoped it" attribution corrected in all three sites (the id exists in
  no story; the `withGuards` note in `worktree.ts` is the real anchor); the barrel range cite →
  symbol.
- **Unit B:** DF5.3's Files list gains the **threading blast-radius row** (W10B-1): `cap-hit-demo.ts`
  + the ten `tests/providers/` fakes/contract suites + five `tests/fleet/` suites the required
  fields break, "the completion criterion is the typecheck itself — the breaking compile IS the
  loudness working"; "fake already listed" corrected. The Wave-9 fix's own false claim repaired
  (W10B-2, parent-verified at source): all three `harvestRun` sites **do** flow `TeardownDeps`
  (`fleet.ts` `const tdeps`, `sandbox-teardown.ts` `const deps`, `teardown.ts`'s internal step) —
  the script-level loudness comes from `TeardownDeps`' required field; `HarvestDeps` needs its own
  because `harvestRun` is its own composition surface and `teardown.ts` forwards a `HarvestDeps`
  view (DF1.10 AC4). DF5.4's C9 two-walk test pinned to one shared scratch copy (C4, in-pass).
- **Unit C:** the seven-edit list's `lastMemory` double-claim struck from 6a's edit (ii) —
  `lastMemory` is (iv), DF3.6b's (W10C-PAIR-1). The ceiling ladder re-grounded on real carriers
  (W10C-6a-2): **two rungs** — the manifest's own `residentSpendCeilingMicros` declaration → the
  shipped 8,000 µ$ fallback — with the operator ruling's *global default* explicitly recorded as
  carrierless (`CONFIG_KEYS` closed at three keys; `perIssueOverrides` is the admission cap; a
  config key is a DF2.8-owned schema addition recorded as a named follow-up) and no second config
  parse invented in `dispatch.ts`; the fill-stamp summary line synced. The unenforceable path
  gained its terminal status (W10C-6b-1): the engine's `instanceof PlacementRefusedError` arm
  writes `telemetry.status = "stopped"` (AC5's proximate-cause rule licenses it) **before**
  firing `onBoundBreach` — the status gate now holds and the stop-latch throw can never fall into
  the degrade arm. AC4's ledger label corrected: absent usage records **unpriced**
  (`unpricedTurns = 1`), not "priced-zero" (three sites; W10C-6a-1, the Wave-9 fix's own wording
  error). In-pass C1s: `boundsPolicy`'s false "DF3.6b cites this definition" cross-ref removed;
  6b's "DF3.3's closed three-cause set" attribution corrected.
- **Unit D:** beyond the BLOCKER — INV-7's validate-only mode **names its route** (W10-W10-1): a
  scratch `RunRecordStore` on a `mkdtempSync` temp dir through the fence-permitted constructor,
  with the shipped store's exact public surface recorded; `orphaned` added to the
  escalation-classification enumeration; `overflow` dispositioned into uncharged-terminal
  (resource-bearing, deterministic, the cap already stopped it); empty `QDS_RUN_ROOT` added to
  DF6.2's refusal-class list; the corrupted `scope-requires-privilege` duplication repaired; the
  superseded "one lock, not two" Wave-2 sentence marked; the stale DF5.3 `:168` cite → symbol.
- **Unit E:** the load-bearing `v5 amendment (DF5.5)` marker added to amendment C's `p1-5`
  prescribed text and amendment D's `p0-7` blockquote (verbatim pasting now lands 11 marker
  paths, matching the declared set); the provenance negative control re-routed from the undefined
  "assertion (2)'s provenance arm" to review, where assertion 1's own control puts it; the
  Hand-off item now names both sanctioned paths (DF6.1a's fix wave **or** the pre-authorised
  fallback edit with its sixth-tripwire + amendment-log duties).

**Accepted residue (optional tiers, per target):** C1/C4 LOWs in all units (cite drift, wording),
DF3.6a's remaining C1 cite-rot cluster (`runContextFrom`/cap-hit-demo/driver ranges), DF6.1a's
C4 LOWs, DF5.5's W10E-4..8. **Next: Wave 12 — five fresh verifiers, one message, scope files
only.**

## Wave 12 result — severity collapsed to seams; two stories crossed; one parent error caught. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave12-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only; blocking findings parent-verified at source before this entry.

| Unit | Wave 10 | Wave 12 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 8 | 8 | 0 | 0 | 3 | 1 | both NOT (high) |
| B (DF5.3+DF5.4) | 8 | 11 | 0 | 0 | **0** | 2 | DF5.3 NOT (high) · **DF5.4 CONVERGED** (high) |
| C (DF3.6a+DF3.6b) | 12 | 14 | 0 | **1** | 2 | 3 | both NOT (high) |
| D (DF6.1a+DF6.1b) | 11 | 8 | 0 | **1** | 2 | 0 | **DF6.1a CONVERGED*** (high) · DF6.1b NOT |
| E (DF5.5) | 8 | 5 | 0 | 0 | 0 | 2 | NOT (high) |
| **TOTAL** | **47** | **46** | **0** | **2** | **7** | **8** | **2 of 9 CONVERGED** |

Per-class: C1×8 · C2×7 · C3×8 · C4×~20 (B0/M13/L~25). *Verifier D marked DF6.1a CONVERGED with
the pair's HIGH assigned to the seam (DF6.1ab-W12-1); the parent attributes the HIGH's fix to
DF6.1a's AC4 (it owns the dispatch-time `fixContext` build) and conservatively holds DF6.1a at
NOT until the fix lands and Wave 14 confirms. Verifier D also marked DF6.1b "CONVERGED" while
counting a C2-MEDIUM on it — resolved mechanically per the bar: a C2-MEDIUM is NOT CONVERGED.

**Parent error, caught by the protocol (recorded per the open-the-file law):** the Wave-9 fix
section's claim that "C's DoD-mirror unreachable trigger [was] aligned to AC3's prose" was
**false** — the disposition was recorded but the edit was never applied. Wave-12's W12C-6a-2
caught the residual at line-level. The fix is applied now (Wave 13), and the Wave-9 section's
claim stands corrected by this note: the rollup asserted more than the diff contained. Lesson:
every disposition gets a grep or a diff receipt, not a memory.

**The two HIGHs (both parent-verified or source-quoted):**
- **W12C-6a-1/6b-1:** `residentRssBytes` has **no production provisioner** — the fill-side stamp
  edit enumerates three operands and closes "and nothing else", while both halves assert the value
  is never absent in production: every dispatched arming run would refuse `bound-config-invalid`,
  taking out DF3.6b's own AC1 proof leg; and W12C-6a-4's shipped-fixture breakage
  (`resident-e2e` steered legs on the DF3.3-owned `pipeline.resident.json`) is the same defect.
  Remedy (parent-selected from the verifier's two): the stamp edit enumerates a **fourth operand**
  — `residentRssBytes`, resolved manifest-declared → else the provisional constant
  (`PROVISIONAL_RESIDENT_RSS_BYTES` = 512 MiB, declared in this story's `resident-bounds.ts`,
  re-set by DF3.6b's live measurement per the standing W6-C-H4 ruling) — preserving AC2a's
  missing-value refusal (the loader still refuses an unstamped manifest; hand-authored fixtures
  bypassing fill still fail) while real dispatched runs arm. The schema-default alternative was
  rejected: it makes AC2a's refusal unobservable.
- **DF6.1ab-W12-1:** attempt 2's brief carries attempt 1's CI-failure output in-box with **no
  redaction mandate** — the pair's own canonical `ghs_` clone-URL shape rides the box-ingress
  channel against INV-3/D8/fact 17. Remedy: one clause pattern-redacting the payload before the
  dispatch-time `fixContext` build + a DoD leg mirroring the escalation-redaction fixture.

**Unit blocking sets (all bounded):**
- **A:** DF3.7-W12-1 (C2) — the approval-request-failure catch is assigned to both `gate-refused`
  ("null on a green verdict") and `vetoed`; disambiguate (a request error is not a gate decision).
  DF3.7-W12-2 (C2) — `driven.markerOk` has no truthful producer on the `promoteStrandedPause`
  path (absent, not false — the story's own not-pretending rule). DF3.7-W12-3 (C3 LOW) — the
  declared `deps` shape cannot feed `TeardownDeps`' `keyApi`/`requestId`/`costLedger` (fail-closed
  on every keyed record). DF3.8-W12-1 (C2) — the `sweep-complete` counter identity has no home for
  post-chain `gate-refused`/`vetoed` outcomes.
- **B:** W12B-2 (C3) — the threading mandate breaks files the Wave-11 row still does not own:
  production `src/fleet/fanout-primitive.ts` (TeardownDeps construction) and
  `scripts/sandbox-reap.ts` (SweepDeps assembly), plus `tests/fleet/approval-gate.test.ts`
  (inline TeardownDeps literal — a file the story itself names), `tests/providers/exedev/driver.test.ts`,
  four `tests/fleet/e2e/` live files, `tests/providers/reaper.test.ts`. W12B-1 (C3) — `createRun`
  is an internal production caller of `provisionAdmittedRun` with no stated carrier for the
  required field (widen `CreateRunOptions`; no no-op sink); plus the cap-hit-demo wording slip
  (it calls `createRun`).
- **C:** the HIGH above; W12C-6a-2 (C2) — the DoD iteration-bound item, applied immediately on
  verification (see the parent-error note); W12C-6a-3 (C2) — "every breach stops the resident"
  contradicts AC3's non-stopping iteration refusal (scope to the spend/memory bounds);
  W12C-6a-4 (C3) — resolved by the fourth-operand stamp.
- **D:** the HIGH above; DF6.1b-W12-1 (C2) — the attempt ladder has no arm for decided approval
  states other than `approved`: `rejected` classifies nowhere, `timed-out` falls to `orphaned`
  instead of `approval-timed-out`, and `pausing` (a real persisted state, `attach.ts`) is
  mischarged as a dead attempt. DF6.1b-W12-2 (C2 LOW) — `overflow` (and the rejected
  classification) missing from the Observability enumeration.
- **E:** W12E-1 (C3) — Test assertion (1)'s provenance definition ("the three enumerated",
  `(now DF…)` within 20 chars) cannot classify the story's own prescribed texts (the p1-2
  "was P1.1…" gloss; the p1-3 header blockquote's meta-references; the pre-authorised p1-18
  fallback's fourth site). W12E-2 (C3) — amendment C's `p1-9` boundary blockquote lacks the
  marker (the `p1-5` sibling got it in Wave 11; `p1-9` missed).

**What held (per reports):** zero C1 in unit A; every arithmetic re-derived exactly in C
(760,960/1,521,920/2,282,880; 504.32; 136,800; $0.0089 crossover) with steering.test.ts 91/0 and
resident.test.ts 39/0; unit B re-ran the 45-case chassis suite exit 0 and verified OQ-4
byte-identity programmatically; D verified the three-field registration, write/read timing,
INV-7's scratch-store route, and the gh 2.93.0 surface; E re-derived the occurrence table and
all successor mappings.

**Next: Wave 13 fix wave** on 2 HIGH + 7 C2 + 8 C3 (all one-clause to one-paragraph), sequential
A→B→C→D→E, then **Wave 14 fresh verify**. Target unchanged: C4-dominant residue.

## Wave 13 fix — every BLOCKER/HIGH/C2/C3 finding applied in-session (2026-09-14)

Sequential in-session A→B→C→D→E, same protocol; the consistency gate green after every unit.
W12C-6a-2 was applied immediately on verification (see the parent-error note above) — the rest
follow.

- **Unit A:** DF3.7's `gate-refused` scoping tightened to a null **as a gate decision** on a green
  verdict — no request error flagged — and the approval-request-failure catch explicitly assigned
  to `vetoed` (a request **error** is not a gate **decision**, even when the flagged report's
  verdict reads green; W12-1). `ChainOutcome.driven`'s `markerOk` made **optional-absent** on the
  `promoteStrandedPause` re-entry — absent, not `false`, the same not-pretending rule that keeps
  `markerWitnessed` out (W12-2). The declared `deps` shape gains the three fields
  `TeardownDeps` requires — `keyApi` (caller-resolved, fail-closed pre-box on a keyed record),
  `requestId` (pre-flight read), `costLedger` (ordinary constructor) (W12-3). DF3.8's
  `sweep-complete` line gains `runs_gate_refused` + `runs_vetoed` — post-chain outcomes counted,
  never folded into `run-observed` or `candidates_skipped` (W12-1).
- **Unit B:** DF5.3's threading row extended with the production sites (`fanout-primitive.ts`'s
  internal `TeardownDeps` construction; `sandbox-reap.ts`'s full `SweepDeps` assembly) and the
  unenumerated test files (`approval-gate.test.ts`'s inline literal, `exedev/driver`, `reaper`,
  the four `tests/fleet/e2e/` live files) (W12B-2). `CreateRunOptions` gains the same required
  field — `createRun` threads it verbatim, no no-op sink — and the cap-hit-demo wording slip
  fixed (its create arm constructs `createRun`'s options) (W12B-1).
- **Unit C:** the fill-side stamp enumerates a **fourth operand** — `residentRssBytes`,
  manifest-declared → else `PROVISIONAL_RESIDENT_RSS_BYTES` (512 MiB, declared in this story's
  `resident-bounds.ts`, re-set by DF3.6b per W6-C-H4) — giving the field its production
  provisioner while the loader's missing-value refusal stays the fail-closed backstop for
  manifests that bypass fill (W12C-6a-1 HIGH; W12C-6a-4's fixture breakage resolves with it —
  `pipeline.resident.json` needs no edit). Technical Notes' residentRssBytes paragraph names the
  provisioner; O20 updated. "Every breach stops the resident" scoped to **spend or memory**
  breaches in the Overview, the Breach-behavior note, and INV-BND-5 (the iteration bound refuses
  without stopping — W12C-6a-3).
- **Unit D:** the HIGH closed in DF6.1b — attempt 2's CI-failure output is **pattern-redacted
  before it enters the dispatch-time brief** (AC2 carrying clause + a new Security bullet: box
  ingress gets the same `redactSecrets` discipline as public egress — INV-3/D8/fact-17 bind "no
  push credential in any box") + a DoD leg mirroring the escalation fixture's three credential
  shapes. The ladder names all five `ApprovalState` readings (W12-1): `awaiting-approval`
  continuation; `pausing` continuation-never-counted (a real persisted state, not a dead
  attempt); `timed-out` → uncharged-terminal `approval-timed-out` (no orphaned fallthrough);
  `rejected` → charged-terminal `approval-rejected`, loop escalates and stops; `approved` per the
  existing arms. The escalation enumeration gains `approval-rejected` and `overflow` (W12-2).
  *Rollup correction: the Wave-12 section provisionally attributed this HIGH's fix to DF6.1a's
  AC4 — the carrying clause is DF6.1b's, and that is where the fix landed.*
- **Unit E:** the load-bearing marker appended to amendment C's `p1-9` boundary blockquote (the
  sibling W10E-1 missed) (W12E-2). Test assertion (1)'s provenance definition widened from the
  20-char `(now …)` window to **any sanctioned same-line form** — `(now DF…)` annotation, a
  `was P1.1 …` gloss, or the header blockquote's marker-named repoint — with the pre-authorised
  `p1-18:50` fallback named as the fourth provenance site whose annotation rides the fallback's
  own rules (W12E-1).

**Accepted residue:** C1/C4 LOWs per unit (register hygiene, drifted ranges, the DD-2 schedule
line, the four-value-sweep wording). **Next: Wave 14 — five fresh verifiers, one message, scope
files only.**

## Wave 14 result — DF5.4 and DF6.1a cross and hold; residue is spec-text precision. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave14-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only; blocking findings parent-verified or source-quoted before this entry.

| Unit | Wave 12 | Wave 14 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 8 | 8 | 0 | **1** | 1 | 3 | both NOT (high) |
| B (DF5.3+DF5.4) | 11 | 8 | 0 | 0 | 2 | **0** | DF5.3 NOT (high, close) · **DF5.4 CONVERGED** (high) |
| C (DF3.6a+DF3.6b) | 14 | 8 | 0 | **2** | 1 | 2 | both NOT (0.85/0.80) |
| D (DF6.1a+DF6.1b) | 8 | 8 | 0 | **2** | 2 | 0 | **DF6.1a CONVERGED** (0.9) · DF6.1b NOT (0.9) |
| E (DF5.5) | 5 | 6 | 0 | 0 | 1 | 1 | NOT (high) |
| **TOTAL** | **46** | **39** | **0** | **5** | **8** | **6** | **2 of 9 CONVERGED** |

**Campaign verdict: NOT CONVERGED — but the two converged stories are new and holding** (DF5.4
converged in Waves 12+14; DF6.1a in Waves 12+14 — DF6.1a carries 3 C1-LOW residue, accepted).
BLOCKERs 0 for the third straight wave; the 5 HIGHs are all C3/C2 specification-precision items
on seams the Wave-13 fixes opened, each with a verifier-offered one-line remedy.

**Parent counter-correction (open-the-file law):** W14-3's "zero matches in tracked source" for
`withGuards` is **false** — `withGuards` exists (`src/reverify/worktree.ts`, definition + the
F064 guard-baseline comment region). The true rot is narrower: Wave-13's characterization of that
comment as a "residual-exposure acknowledgment" over-read it; the note is the F064 baseline
comment. The Wave-15 fix corrects the attribution wording; this note corrects the verifier's
zero-match claim.

**The blocking sets (all bounded, most one-line):**
- **A:** DF3.7-W14-1 (HIGH C3) — `requestApproval` never returns null; every gate refusal is a
  **throw**, so Wave-13's "null as a gate decision" scoping specified a producer that cannot
  fire, and the hand-run live-box `pausing` case arrives via the approval-request-failure flag,
  indistinguishable in the returned contract. Remedy: drive `gate-refused` off the **typed gate
  refusal throw** (the gate's `{code, message, remediation}` payload is the discriminator); every
  other approval-request failure and every non-green verdict stays `vetoed`. DF3.7-W14-2 (C3 M) —
  the union has no arm for the non-null `pause-in-progress`/`rebound` outcomes the admitted
  unfenced hand-run can produce. DF3.8-W14-1 (C2 M) — `candidates_skipped` has no producer; pin
  it to the partial-pass truncation arm (the count left behind). DF3.7-W14-3 (C1 M) — the F106
  attribution wording (see the counter-correction above).
- **B:** W14B-3 (C2 M) — the reaper's internal credential-deps literal (runId-less step context)
  cannot emit against `audit_links.run_id` NOT NULL; remedy: the one **named** no-op sink, with
  INV-AUDIT-4's no-manufactured-links rationale (a run-less revocation has no hop to serve).
  W14B-2 (C2 L) — hop-5 prose omits `tier1-provision-status.live` from `createRun`'s callers.
  W14B-1 (C1 L) — `patterns` listed under `tests/providers/`, file is `tests/fleet/`.
  **Pairing enumeration verified EXHAUSTIVE against the verifier's own grep** — the Wave-11/13
  threading rows hold.
- **C:** W14C-6a-1 (HIGH C3) — the fail-closed loader refusal fires on shipped **armed fixtures**
  no story owns (`resident-e2e.test.ts`, `pipeline-run.test.ts` arm on hand-authored manifests
  that bypass the fill stamp). Remedy: the fixtures + test files enter DF3.6a's Files list; the
  fixtures declare the field. W14C-PAIR-1 (HIGH C3) — the provisional constant has **two
  contradictory homes** (6a says `resident-bounds.ts` twice; the older W6-C-H4 text in 6a's
  provisional note + 6b's Files/DoD says `manifest.ts` three times; `manifest.ts` is empty by
  6a's own required-field design). Remedy: re-home consistently to `resident-bounds.ts`.
  W14C-6a-2 (C2 M) — the mandatory e2e fixture refuses at load (`requiredBudgetMs` 96,000 >
  `runBudgetMs` 50,000 under the retries:5 adaptation); specify the budget fields.
- **D:** DF6.1b-W14-2 (HIGH C3) — `approved` + no `fixContext` + no terminal has no ladder arm
  and is absorbed by `orphaned`, but it is **DF6.1a AC3's own sanctioned continuation**
  (scope-check→push re-run on an approved record). Remedy: a sixth reading — continuation,
  charges nothing. DF6.1b-W14-1 (HIGH C2) — Wave-13's `rejected` = charged-terminal contradicts
  AC2's own charging rule: a rejected attempt **never pushed** → charges **zero**; terminal,
  loop escalates and stops. DF6.1b-W14-3 (C2 M) — `overflow` missing from AC2's reproduce-set and
  the DoD uncharged-mix list.
- **E:** W14E-1 (C2 M) — assertion-1's sanctioned forms still cannot classify the prescribed
  `p1-9:25` text (`(was P1.6…)`/`(was P1.8…)` parentheticals + inline marker); generalize to
  `was P1.x` and admit the inline marker. W14E-2 (C3 M) — `p1-7`/`p1-14`/`p0-9` have no
  marker-bearing prescribed text (8 marker paths as-prescribed vs the 11 AC1 asserts); mandate
  the marker on every touched line. W14E-3 (C1 M) — the DF6.1b composition correction misrecords
  the live text (three `gh` invocations; `statusCheckRollup` only as negative control) — and the
  **yaml P1.18 row shares the misrecord** (parent-owned edit, this wave).

**Next: Wave 15 fix wave** on 5 HIGH + 8 MEDIUM (all one-line-class), sequential A→B→C→D→E, then
**Wave 16 fresh verify**. Target unchanged: C4-dominant residue.

## Wave 15 fix — every BLOCKER/HIGH/C2/C3 finding applied in-session (2026-09-14)

Sequential in-session A→B→C→D→E, same protocol; the consistency gate green after every unit.

- **Unit A:** the `gate-refused` producer **re-grounded on the throw** (W14-1's HIGH):
  `requestApproval` never returns a refusal — every gate refusal throws — so the discriminator is
  the thrown error carrying the gate's typed refusal code; every other approval-leg failure, the
  non-green verdict and `nothing-to-verify` stay `vetoed`; the shipped non-null
  `pause-in-progress`/`already-decided`/`rebound` outcomes get their own **`handed-off`** arm
  (W14-2) — union, Observability `kind` list, AC5, DoD item and negative controls all aligned.
  `candidates_skipped`'s producer pinned: the partial-pass truncation arm (the count the
  partial-pass line names as left behind) (W14-1). The F106 attribution wording corrected to the
  F064 guard's actual content (`withGuards` sweeps the verify body's descendants — a second
  concurrent re-verify's processes land in the sweep, not behind a fence), across DF3.7 AC5,
  INV-IBOX-16 and DF3.8 INV-IBOX-17 (W14-3) — with the parent counter-correction recorded: the
  verifier's "zero matches" claim was false, `withGuards` exists.
- **Unit B:** the reaper's internal credential-deps literal named as **the one deliberate no-op
  sink** — a run-less revocation has no hop to serve, `audit_links.run_id` is NOT NULL, and
  INV-AUDIT-4's no-manufactured-links rule is the rationale (W14B-3). Hop-5 prose gains the third
  `createRun` caller (`tier1-provision-status.live`); `patterns` re-listed under `tests/fleet/`
  (W14B-2/-1).
- **Unit C:** the shipped **armed fixtures gain a Files row** — `pipeline.resident.json` declares
  `residentRssBytes` (one field, the same single-value budget shape DF3.6b holds on the bounds
  constant), and the two armed-witness test files are listed so the blast radius is owned, not
  discovered (W14C-6a-1 HIGH). The provisional constant **re-homed consistently to
  `resident-bounds.ts`** in all five mentions (6a's provisional note, 6b's Files entry, 6b's DoD
  test) — `manifest.ts` carries no default, because a schema default would kill AC2a's refusal;
  the W6-C-H4 rationale stands, the file moved with the required-field design (W14C-PAIR-1
  HIGH). The e2e fixture adaptation now specifies `runBudgetMs` = 120,000 against the computed
  96,000 ms required budget (W14C-6a-2).
- **Unit D:** the ladder gains the **sixth reading** — `approved` + no `fixContext` + no terminal
  ⇒ **continuation, the sanctioned re-attempt** (DF6.1a AC3's scope-check→push re-run; charges
  nothing, counts nothing) (W14-2 HIGH). `rejected` re-fated to **terminal, `approval-rejected`,
  charging zero** — AC2's own rule charges only pushed-then-CI-failed attempts, and a rejected
  attempt never pushed (W14-1 HIGH); the escalation enumeration's phrasing synced. `overflow`
  added to AC2's reproduce-set and the DoD uncharged-mix list (W14-3).
- **Unit E:** assertion-1's sanctioned forms generalized — `was P1.x …` gloss **or parenthetical**,
  and the **inline marker on the repointed line itself** admitted as a form (p1-9's
  `(was P1.6…)`/`(was P1.8…)` idioms now classify) (W14E-1). The Contract DoD mandates **the
  marker on every touched line**, covering the bare-repoint files `p1-7`/`p1-14`/`p0-9` whose
  amendments prescribe directions — the as-prescribed marker set is the declared eleven
  (W14E-2). The DF6.1b composition misrecord corrected to the live three-invocation text, and the
  **yaml's P1.18 + DF6.1b row comments re-corrected** (parent-owned, appended not rewritten)
  (W14E-3).

**Accepted residue:** C1/C4 LOWs per unit. **Next: Wave 16 — five fresh verifiers, one message,
scope files only.**

## Wave 16 result — three cross and hold; the residue narrows to one design decision and prose. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave16-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only; blocking findings source-quoted before this entry.

| Unit | Wave 14 | Wave 16 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 8 | 8 | 0 | **2** | 1 | 1 | both NOT (0.95/0.92) |
| B (DF5.3+DF5.4) | 8 | 6 | 0 | 0 | 0 | 1 | DF5.3 NOT (0.85) · **DF5.4 CONVERGED** (3rd wave) |
| C (DF3.6a+DF3.6b) | 8 | 8 | 0 | **1** | 1 | 0 | DF3.6a NOT (0.9) · **DF3.6b CONVERGED** (0.9) |
| D (DF6.1a+DF6.1b) | 8 | 6 | 0 | **1** | 0 | 0 | both NOT (0.9/0.85) — DF6.1a drops on the cross-half HIGH |
| E (DF5.5) | 6 | 4 | 0 | 0 | **0** | **0** | **DF5.5 CONVERGED** (high) |
| **TOTAL** | **39** | **32** | **0** | **4** | **3** | **1** | **3 of 9 CONVERGED** |

**Campaign verdict: NOT CONVERGED — DF5.4, DF3.6b, DF5.5 cross and hold; DF6.1a drops on a real
cross-half sizing defect the fresh eyes caught.** Zero BLOCKERs fourth straight wave. The
remaining 4 HIGHs are one design decision (below) plus three counter/enumeration completions.

**The design decision (DF6.1b-W16-1, cross-half C2-HIGH, fix text in DF6.1a):** DF6.1a's resolved
Open Question sizes the per-issue override at `parentSpend + 2 × perAttemptCap` — the **charged**
budget only — while DF6.1b's ceilings sanction up to **7 resource-bearing boxes per PR** (2
charged + 3 uncharged + 1 dispatch-refused + 1 out-of-scope-diff), and `admitIssue` consumes the
same ceiling on every dispatch. Consequences: one zero-charge out-of-scope box plus one charged
box starves the designed second charged attempt; the uncharged ceiling of 3 is unreachable live
(its named escalation can never fire while the fixture-only DoD test passes). Remedy
(verifier-offered, parent-selected): the override is sized to the **worst-case union** — 2 charged
attempts at `perAttemptCap` plus each uncharged/resource-bearing attempt at its own per-attempt
spend cap — and the loop's issue-ceiling pre-flight **asserts that coverage**, refusing
`issue-ceiling-insufficient` when the declared override cannot fund it.

**Unit blocking sets:**
- **A:** DF3.7-W16-1 (HIGH C2) — the Wave-15 discriminator is still unimplementable: every shipped
  gate refusal **throws a plain Error** (codes exist only as prose in the message) and
  `reverify()`'s catch flattens any refusal to `approval: null` + one generic
  `approval-request-failed` flag — there is no field to discriminate on, and the story's own
  misattribution MUST-fail test is unwritable. Remedy (parent-selected, honest collapse): **one
  truthful `approval-failed` arm** replaces the gate-refused/vetoed split for the approval leg —
  the shipped contract cannot distinguish gate-declined from transport-failed without re-opening
  DF5.1's contract (out of scope); the arm carries the error, its remediation names both
  `fleet teardown <runId>` and gate-log investigation. DF3.8-W16-1 (HIGH C2) — the sweep counters
  fund two post-chain arms; the union (after the collapse + `handed-off`) has three. DF3.7-W16-2
  (C2 M) — no arm for reachable chain throws (`teardownSandbox` step failures, the report leg
  outside `reverify()`'s try blocks), both post-`closedAt`; add `chain-failed`. DF3.7-W16-3
  (C3 M) — AC5's pre-flight order (extension then `closedAt`) strands the crashed-chain `pausing`
  record; `pausing` must precede the `closedAt` refusal. DF3.7-W16-4 (C1 M) — `startResident`
  uses no KeyApi; the chain is `openRouterKeyApi`.
- **B:** W16B-1 (C3 M) — `tests/providers/quota.test.ts` (three fresh `CreateRunOptions`
  literals) missing from the threading row; hop-5 prose also omits it and `driver-contract.test`.
  W16B-2 (C1 M) — **`runCredentialLifecycle` is a phantom composition site** (named as one of the
  four loud surfaces; no such function exists — only a stale `dispatch.ts` comment); the real
  `CredentialDeps` compose sites sit in owned files, and the `SweepDeps` assembly is a fifth
  unnamed surface. Sub-note: `runId: null` lives in `credentials.ts` internals, not the reaper
  literal — the no-op-sink substance holds.
- **C:** W16C-6a-1 (HIGH C3) — AC2a requires **four** fields on every armed hand-authored
  manifest, but the `pipeline.resident.json` Files row authorizes "(one field)" — the shipped
  DF3.3 armed e2e (verified 12-green today) would refuse at load, needing an unauthorized edit
  depth; the E2E Slice's `pipeline.bounds.json` enumeration omits the two chain operands too.
  Remedy: the row authorizes the **full required set**. W16C-6a-2 (C2 M) — the budget arithmetic
  re-derives to **106,000 ms** (attempts 96,000 + routing margin 2×5,000), not 96,000; the
  stated 120,000 still funds. C1 cluster: cap-hit-demo cites, `deriveBuildId`'s real home
  (`scripts/build-exedev-image.ts` — shared with the yaml), `pipeline-run.ts:3294` drift.
- **D:** the cross-half HIGH above. LOWs: "twelve-field core" (13 — `requestId` added by
  `8008e4bb`); `walkAuditChain` zero-in-src (not once); AC3's "third invocation" overstatement
  against the persisted-anchor recovery; AC2's two uncharged enumerations disagree on `overflow`.

**What held:** DF5.4's pairing enumeration verified EXHAUSTIVE against B's own grep; DF3.6b
converged (status vocabulary, cause union, exitStatus chain, tier-4 figures — 401 µ$ re-derived);
E verified all nine prescribed inserts carry the marker and the four provenance forms classify
every prescribed artifact; A ran 481 pass/0 fail across six scoped suites; B ran 45 chassis cases;
D re-measured the gh surface live. All arithmetic in C re-derived.

**Next: Wave 17 fix wave** on 4 HIGH + 3 MEDIUM (+ the C1 clusters in-pass), sequential
A→B→C→D→E, then **Wave 18 fresh verify**. Target unchanged: C4-dominant residue.

## Wave 17 fix — every BLOCKER/HIGH/C2/C3 finding applied in-session (2026-09-14)

Sequential in-session A→B→C→D→E, same protocol; the consistency gate green after every unit.

- **Unit A (the arm design, settled on source truth):** the Wave-15 discriminator was still
  unimplementable — the shipped gate refusal **throws a plain `Error`** (codes only as prose in
  the message) and `reverify()`'s catch flattens any refusal to `approval: null` + one generic
  `approval-request-failed` flag. Resolved by **honest collapse**: the approval leg reports **one
  `approval-failed` arm** (`{kind, error}`, exit 6, remediation naming both `fleet teardown
  <runId>` and the gate log) — no gate-vs-transport classification the shipped contract cannot
  carry, and no message-sentinel contract this story refuses to specify; `vetoed` now means only
  the re-verifier's own judgment (non-green verdict, `nothing-to-verify`); a new **`chain-failed`**
  arm carries the reachable post-`closedAt` chain-step throws (`teardownSandbox` step failures,
  the report leg outside `reverify()`'s try blocks — W16-2); `handed-off` retained for the
  gate's non-null outcomes. Union, Observability `kind` list, AC5, DoD item and negative controls
  aligned; the AC5 misattribution MUST-fail test is now writable (it fails any implementation
  claiming a discriminator the contract does not carry). DF3.8's sweep line funds **all four
  post-chain arms** (`runs_vetoed`/`runs_approval_failed`/`runs_chain_failed`/`runs_handed_off`)
  and the accounting identity is stated to reconcile `candidates_enumerated` for every reachable
  arm (W16-1's HIGH). AC5's pre-flight **reordered**: `pausing` → extension → `closedAt` — a
  crashed chain's `pausing` record carries `closedAt` by design and must reach
  `promoteStrandedPause`, not the closure refusal (W16-3). The `keyApi` source corrected to the
  shipped `openRouterKeyApi` chain (`resident.ts` mints nothing; W16-4).
- **Unit B:** the threading row gains `tests/providers/quota.test.ts` (three fresh
  `CreateRunOptions` literals) and hop-5's caller prose gains `quota.test` +
  `driver-contract.test` (W16B-1). **Parent counter-correction:** W16B-2's "phantom
  `runCredentialLifecycle`" claim is **false** — the function exists, exported at
  `src/providers/credentials.ts` (taking exactly `CredentialDeps`), and W14-B's own report
  verified it as "a genuine single composition surface for all four credential events"; the
  verifier's grep missed it. Applied kernel: the no-op-sink sentence's `runId: null` location
  re-attributed to `credentials.ts`'s internals (W14B-3's substance held).
- **Unit C:** the `pipeline.resident.json` Files row now authorizes the **full required
  bound-operand set** (four fields, not "one field") — AC2a requires all four on every armed
  hand-authored manifest, and the fixture arms beside a witnessed brief in every `resident-e2e`
  leg; the E2E Slice's `pipeline.bounds.json` enumeration synced (W16C-6a-1 HIGH). The e2e
  budget arithmetic corrected to **106,000 ms** (attempts 96,000 + routing margin 2 × 5,000);
  120,000 still funds (W16C-6a-2). C1 cluster: the cap-hit-demo cites → symbol
  (`runBudgetCapMicros`), the `pipeline-run.ts:3294` cite → symbol.
- **Unit D:** the cross-half sizing HIGH closed in DF6.1a — the per-issue override is sized to
  the **worst-case union of both ceilings** (`parentSpend + 2 × perAttemptCap +
  unchargedCeiling × perAttemptSpendCap`, each uncharged attempt bounded by the per-attempt
  spend cap whose exhaustion classifies it `overflow`), and the loop's issue-ceiling pre-flight
  **asserts that coverage**; both sizing sentences (Scope/Technical-Notes + the answered Open
  Question) updated. LOWs: "twelve-field core" → **thirteen** (`requestId`, `8008e4bb`) in both
  halves; `walkAuditChain`'s "exactly once in src/" split (it appears **zero** times — parent
  verified: `grep -rn walkAuditChain src/` = 0, `recordAuditLink` = 1); AC3's "third invocation
  would find it expired" overstatement reworded to the persisted-anchor's remaining-time
  semantics; DF6.1b's second uncharged enumeration gains `overflow` (W14-3's remainder); and the
  **yaml's DF3.6b row** `deriveBuildId` cite re-homed to `scripts/build-exedev-image.ts`
  (parent-owned; a first-pass edit briefly corrupted the row's title field and was reverted in
  the same session — the gate confirms the yaml parses and the title is intact).

**Accepted residue:** C1/C4 LOWs per unit. **Next: Wave 18 — five fresh verifiers, one message,
scope files only.**

## Wave 18 result — five cross; one design deletion and one arithmetic widen remain. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave18-{A,B,C,D,E}-*.md`. Fresh eyes,
scope files only; blocking findings source-verified before this entry.

| Unit | Wave 16 | Wave 18 | BLOCKERs | HIGHs | C2 | C3 | Verdicts |
|---|---|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 8 | 8 | 0 | **1** | 0 | 0 | DF3.7 NOT (0.85) · **DF3.8 CONVERGED** (0.80) |
| B (DF5.3+DF5.4) | 6 | 3 | 0 | 0 | **0** | **0** | **DF5.3 CONVERGED** (0.9) · **DF5.4 CONVERGED** (3rd wave) |
| C (DF3.6a+DF3.6b) | 8 | 6 | 0 | 0 | **0** | **0** | **both CONVERGED** (0.90/0.88) |
| D (DF6.1a+DF6.1b) | 6 | 12 | 0 | **1** | 2 | 0 | both NOT (0.85/0.75, marginal) |
| E (DF5.5) | 4 | 8 | 0 | 0 | **0** | **0** | **DF5.5 CONVERGED** (2nd wave) |
| **TOTAL** | **32** | **37** | **0** | **2** | **3** | **0** | **6 of 9 CONVERGED** |

**Campaign verdict: NOT CONVERGED — but six of nine crossed, five of them holding across waves.**
Zero BLOCKERs fifth straight wave. The two remaining blocking items:

- **DF3.7-W18-1 (HIGH C2):** the `gate-refused` arm survived Wave 17's collapse in the union, the
  exit table and two reference lists — and A's evidence sealed its fate: the shipped chain sets
  `closedAt` **before** `reverify()` runs while the gate's live-infra refusal is conditioned on
  `closedAt === undefined`, so the arm had **no reachable producer on any path**. Remedy applied
  immediately (the verifier's first option): **deleted** — arm, exit-table case, and all
  references; `approval-failed` (with both remediations) is the one truthful report of an
  approval-leg failure. Zero `gate-refused` mentions remain (grep-verified).
- **DF6.1a-W18-1 (HIGH C2, cross-half):** Wave 17's sizing union covered 5 of the **7**
  resource-bearing boxes — the **dispatch-refused** and **out-of-scope-diff** boxes also reserve
  against the per-issue ceiling (`admitIssue` reserves on every dispatch; both boxes sink real
  box-hours and a capped key before their zero-charge classification), so attempt 2 / the third
  uncharged attempt could hit `budget-exceeded` on exactly the path the sizing exists to keep
  open. Remedy applied: the union is now **`parentSpend + 2 × perAttemptCap + (unchargedCeiling +
  2) × perAttemptSpendCap`**, the DoD's issue-ceiling leg asserts the union (a charged-only
  threshold MUST fail), and DF6.1b's `scope-requires-privilege` clause gains the explicit
  later-invocation stop its siblings state, with its reservation counted (W18-1's C3 MEDIUM).
  Plus DF6.1a-W18-2 (C2 M): the DoD leg's stale charged-only threshold replaced.

**Parent counter-corrections:** none this wave — but one parent editing error, self-caught: the
yaml DF3.6b row's title field was briefly corrupted by a mis-anchored cite edit and was reverted
in the same session (the consistency gate confirms the yaml parses and the title is intact; the
`deriveBuildId` cite re-home landed correctly in the row's comment).

**Next: Wave 19 — targeted re-verify of the three stories fixed since their Wave-18 verdicts**
(DF3.7 · DF6.1a+DF6.1b; the six converged stories were untouched in Wave 19 and hold), then the
Phase-3 operator gate if all three land CONVERGED.

## Wave 19 fix — the three open stories' blockers applied (2026-09-14)

Applied immediately on Wave-18 verification, before dispatching the targeted re-verify:

- **DF3.7-W18-1 (HIGH C2):** the `gate-refused` arm **deleted** — from the `ChainOutcome` union,
  the verbs.ts exit-table exit-6 case, the test-file list, and the Observability head (zero
  `gate-refused` mentions remain, grep-verified; DF3.8 already carried none). `approval-failed`
  is the one truthful report of an approval-leg failure; the union is
  driven · unsettled · refused · vetoed · approval-failed · chain-failed · handed-off, and every
  arm now has a producer the shipped contract can actually reach.
- **DF6.1a-W18-1/W18-2 (HIGH C2 + C2 M):** the sizing union widened to
  `parentSpend + 2 × perAttemptCap + (unchargedCeiling + 2) × perAttemptSpendCap` — counting the
  dispatch-refused and out-of-scope-diff boxes' per-issue reservations (re-derived against
  `admitIssue`/`issueBudgetSnapshot`, committed = spent + reserved) — in both the Scope/Technical
  Notes sentence and the answered Open Question; the DoD issue-ceiling leg asserts the union and
  MUST-fails a charged-only threshold.
- **DF6.1b-W18-1 (C3 M):** `scope-requires-privilege` gains the explicit later-invocation stop
  (recorded at most once per PR, its own first-occurrence escalation is its bound), with its
  reservation counted in the sizing union's "+2".

The six converged stories (DF3.6a, DF3.6b, DF5.3, DF5.4, DF3.8, DF5.5) were untouched. **Next:
Wave 19 — two targeted verifiers (DF3.7 · DF6.1a+DF6.1b), then the Phase-3 operator gate.**

### Wave 19 verifier findings + same-session fixes (DF3.7 · DF6.1a · DF6.1b)

Both Wave-19 verifiers returned NOT CONVERGED on small, precise items; all applied in-session:

- **DF3.7-W19-1 (BLOCKER C3):** the union never gave the story's own three typed terminal
  outcomes an arm. Fixed: **`unsettled` gains `terminal?: {code, message, remediation}`** —
  present exactly when the invocation ends on a typed terminal arm (AC2(a)'s `box-unreachable`
  skip-streak fill, AC2(d)'s `run-engine-dead`, AC3's `run-completion-unobserved` window-or-streak
  — the two fills stay distinct codes), absent mid-window; producer named (the observer at the
  terminal tick); exit derives from the code. Negative controls added (streak-fill as `driven`
  fails; conflating window-expiry with skip-streak-fill fails). W19-2: `vetoed` pinned to
  **exit 6**. W19-3: `approval-failed`'s error carrier named — the caller's own hands (a thrown
  message, or the runner's `approval-request-failed` flag off the flagged report `reverify()`
  returns), not an unwired log sink.
- **DF6.1a-W19-1 (C2, root defect, cross-half):** the "+2" was **wrong twice** — three zero-charge
  boxes reserve (dispatch-refused, out-of-scope-diff **and scope-requires-privilege**), and the
  per-attempt rate is the shipped **uniform** per-dispatch reservation. Fixed:
  `parentSpend + 2 × perAttemptCap + (unchargedCeiling + 3) × perDispatchSpendCap`, both terms
  defined at first use (`perAttemptCap` = the budget DF6.1b's AC2 charges; `perDispatchSpendCap` =
  the shipped uniform reservation, `admittedCeiling = min(keyCap, remaining)`), the reachable
  maximum stated as 5–6 boxes with the union kept conservative, and DF6.1b's attribution sentence
  synced ("+3 counts all three"). DF6.1a-W19-2 (C1): the answered Open Question's exit name
  unified to `fix-ceiling-insufficient`.
- **DF6.1b-W19-2/3 (C3 LOW):** `scope-requires-privilege` gains its DoD leg (a subsequent
  invocation dispatches nothing; omitting its reservation from the union fails); the
  `bot-response-to-fix` predicate's fresh-PR case stated (no `attemptSha` ⇒ treated as
  all-newer). W19-5: the "registers exactly `fixContext` and `fixOutcome`" claim reworded to the
  pre-registered set plus this story's three additions.

**Next: Wave 20 — targeted confirming verifiers on the same three stories (the six converged
stories remain untouched), then the Phase-3 operator gate.**

## Wave 20 result + same-session fixes — the union design is settling; three prose-class items left. VERDICT: NOT CONVERGED.

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave20-{A,D}-*.md` (targeted: DF3.7 ·
DF6.1a+DF6.1b). DF3.8/DF5.3/DF5.4/DF3.6a/DF3.6b/DF5.5 hold converged, untouched.

| Story | Wave 18 | Wave 20 | Blocking |
|---|---|---|---|
| DF3.7 | NOT (1 H) | NOT (0.95) — 1 C3-H + 1 C2-M | W20-1: `chain-failed` was post-`closedAt`-only, but `teardownSandbox`'s harvest/destroy abort **with the record open**; W20-2: `vetoed` must name the `error`-verdict case |
| DF6.1a | NOT (2 items) | NOT — 1 C2-BLOCKER + 2 C2-M | W20-1: the DoD leg carried Wave-18's stale `(+2) × perAttemptSpendCap` — a Wave-19 partial sync (parent error, self-caught); W20-3: `writes !== []` is a reference compare that counts the shipped lead as write-capable; W20-4: `.factory/fix-scope.json`'s read never names the shipped shared guard |
| DF6.1b | NOT (marginal) | NOT — 1 C2-H + 1 C2-M | W20-1: the fresh-PR clause read as an intake predicate kills attempt 1; W20-2: `fix-scope-missing` has no terminal classification |

All five applied in-session, gate green:
- **DF3.7:** `chain-failed` **widened** — "a chain step other than the approval leg threw, at any
  point in the chain" (harvest/destroy abort with the record open; box-hours ingest post-close;
  the report leg — every one lands here); `vetoed` names the `error` verdict with its own
  remediation line.
- **DF6.1a:** the DoD issue-ceiling leg synced to Technical Notes' formula —
  `(unchargedCeiling + 3) × perDispatchSpendCap`, with "any formula whose constant or rate term
  diverges" as the MUST-fail; the single-fixer guard's spelling corrected to the shipped
  three-state expression (`writes !== null ? writes.length > 0 : true` — a bare `writes !== []`
  reference-compare counted the shipped lead as write-capable); `.factory/fix-scope.json`'s read
  path **named**: `readGuardedFile` (`src/providers/allowlist-path.ts` — parent-verified exported),
  the same guarded config-read the other two security-deciding files go through.
- **DF6.1b:** the fresh-PR `bot-response-to-fix` clause scoped to **re-invocations only** (a
  first comment set is the loop's ordinary input; attempt 1 dispatches per AC1) + a DoD leg
  pinning it; `fix-scope-missing` classified — pre-dispatch, provisions nothing, escalates once,
  never a continuation — with its DoD leg and a place in the escalation enumeration.

**Next: Wave 21 — two targeted confirming verifiers (DF3.7 · DF6.1a+DF6.1b), then the Phase-3
operator gate.**

### Wave 21 verifier findings + same-session fixes (DF3.7 · DF6.1a · DF6.1b)

The union design held everywhere probed (A7: "complete and one-to-one"; D: the sizing formula
byte-identical at all three statements and covering every sanctioned box). Residue applied
in-session:

- **DF3.7 (3 M, all fixed before the Wave-22 check dispatched):** the `run-completion-unobserved`
  parenthetical de-conflated (either fill yields the one code; it stays distinct from
  `box-unreachable`); the exit-table glosses completed (exit 1 + `box-unreachable`; exit 4 names
  the verb's pre-flight record assert as its producer; exit 5 + `run-already-closed` and the
  host-root-unusable `reverify()`; exit 6 enumerates all four post-chain arms); `refused` claims
  the exit-4 producer.
- **DF6.1a-W21-1 (HIGH C2+C3):** AC6 now states the **dual-read design** — the enforcement read on
  the harvested diff (invocation 2) plus the **attempt-start probe** host-side in
  `feedback-run.ts` before attempt 1's dispatch (the placement the e2e demo and DF6.1b's stop-leg
  mandate) — one artifact, this story's own code, no second implementation sanctioned.
  DF6.1a-W21-2 (C1 L): "seven resource-bearing boxes" → **eight** (the corrected formula's
  arithmetic).
- **DF6.1b-W21-6 (C2 M):** `fix-scope-missing`'s bound restated as **deterministic repetition,
  no durability claimed** — no run record is minted on that path, `fixOutcome` is
  write-once-at-terminal, no registered field carries a seen-it marker, so the story claims the
  repetition and nothing more. DF6.1b-W21-2/3 (C3 L): `scope-requires-privilege`'s DoD leg added;
  the `bot-response-to-fix` fresh-PR case stated.

**Next: Wave 22 — two targeted confirming verifiers (DF3.7 · DF6.1a+DF6.1b), then the Phase-3
operator gate.**

## Waves 20–23 — the targeted convergence loop. CAMPAIGN VERDICT: **CONVERGED — 9 of 9.**

Reports: `_bmad-output/evidence/qds-story-review-2026-09-08/wave20-*` (DF3.7 · DF6.1a/b),
`wave21-*` (same), `wave22-*` (same), `wave23-final-df37-df61.md` (all three). The six stories
that crossed earlier (DF3.6a, DF3.6b, DF5.3, DF5.4, DF3.8, DF5.5) held converged, untouched, per
the no-prose-past-converged-verdict rule; the targeted loop ran only on DF3.7, DF6.1a and
DF6.1b.

| Story | Converged in | Final residue (accepted per target) |
|---|---|---|
| DF3.6a | Wave 18 | C1×2, C4×3 LOW |
| DF3.6b | Wave 18 | C1×1, C4×1 LOW |
| DF3.7 | **Wave 23** | C4×2 LOW |
| DF3.8 | Wave 18 | C4×4 LOW |
| DF5.3 | Wave 18 | C4×2 LOW |
| DF5.4 | Wave 12 | C1×1, C4×1 LOW |
| DF5.5 | Wave 16 | C1×1, C4×7 LOW |
| DF6.1a | **Wave 23** | C4×1 LOW |
| DF6.1b | **Wave 23** | C4×1 LOW |

**Every story: zero BLOCKER, zero HIGH, zero C2, zero C3 — the C4-dominant target met.** Wave
23's final pass found zero blocking items across all three open stories (4 C4-LOW total), and its
positive set held the entire settled surface: the seven-arm ChainOutcome union ↔ exit table ↔ AC5
↔ Observability ↔ DoD one mapping (three distinct terminal fills, pre-flight order consistent at
every statement); the sizing formula character-identical at all three statements with the +3
counting all three zero-charge reservers and the eight-box sum correct; every zero-match claim
positively controlled; every cross-story seam (DF3.8 Deviation 1, DF2.11 eighth call site, DF5.1
cap, DF5.2 INV-PR-1/5/6/7, DF5.3 INV-AUDIT-6/Ten hops, DF5.5 P1.18 handoff, DF6.2 refusal list,
DD-1/2/2a/8/10) verified real.

**How the loop closed (Waves 19–23, the tail):** Wave 19 caught a **parent error** — the Wave-9
rollup had recorded W9C-6a-2 as fixed without applying the edit; fixed and the lesson recorded
(every disposition gets a grep/diff receipt). Waves 20–22 then converged the union design by
deletion and precision: the `gate-refused` arm (no reachable producer — the chain closes
`closedAt` before `reverify()` runs and the gate's refusal requires it undefined) was **deleted**
in favor of the one truthful `approval-failed` arm; `chain-failed` widened to any chain step
(teardown aborts with the record open); the sizing union settled at
`parentSpend + 2 × perAttemptCap + (unchargedCeiling + 3) × perDispatchSpendCap` (three
zero-charge reservers, one uniform rate — terms defined at first use); the fresh-PR
`bot-response-to-fix` clause scoped to re-invocations; `fix-scope-missing` and
`scope-requires-privilege` given terminal classifications, stop rules and DoD legs; AC6's
dual-read design sanctioned; and the exit-table glosses completed. Two verifier claims were
counter-corrected at source (W16B-2's "phantom `runCredentialLifecycle`" — exported at
`credentials.ts`; W14-3's "zero matches" for `withGuards` — exists; the rot was the attribution
wording, and both corrections are recorded above).

**Operational state at convergence:** all edits uncommitted on `dev` (story specs, 3
seam-ownership tables, tracker, 2 yaml comment corrections, evidence dir); `bun
scripts/check-story-consistency.ts` green; sprint-status yaml rows unchanged in status
(ready-for-dev). **Next: the Phase-3 operator gate** — commit + PR (`feature/`, base and target
`dev`) on operator confirmation, then dev-phase implementation via `qds-dev` in dependency order
(DF5.5 last; its yaml meta-block recompute precondition already verified at 42/169).

## Wave 5 result — the protocol predicted 30–50%; we got 93%

| Verifier | B | H | M | L | Total |
|---|---|---|---|---|---|
| A (DF3.7+DF3.8) | 3 | 5 | 6 | 3 | 17 |
| D (DF6.1a+DF6.1b) | 4 | 7 | 7 | 4 | 22 |
| B (DF5.3+DF5.4) | 7 | 8 | 6 | 2 | 23 |
| E (DF5.5+DF2.11+DF2.12) | 5 | 10 | 15 | 6 | 31 |
| C (DF3.6a+DF3.6b) | 6 | 10 | 9 | 7 | 32 |
| **TOTAL** | **25** | **40** | **43** | **22** | **125** |

**The failure mode changed category between waves, and that is the campaign's most useful result.**
Waves 0–4 hunted *citation accuracy* and largely fixed it. Wave 5's verifier B put it exactly:
citations were verified accurate to an unusual degree (~40 checked, one off-by-one), yet **every one
of its BLOCKERs was "the cited code doesn't do on a real run what the story assumes."** Hop-5's
emitters have no non-test callers; `reap` never fires on a healthy run. A fix pass that re-checks
line numbers finds none of that. Fix waves were re-briefed to trace call paths instead.

**Fix waves can be wrong in the same category as the defect they replace.** DF3.6a's spend ceiling
was derived wrongly *twice* — the original could not fire, and the 5b re-derivation still could not,
because it computed the healthy maximum as `Σ retries` while ignoring the story's own iteration
bound. Third derivation is shown inline in the story so the next reviewer checks it in one pass.

**Parent rulings caused four BLOCKERs.** Logged in full below; the rule adopted in response is
"open the file before ratifying anything," and it is now non-negotiable.

## Open question — awaiting operator ruling (owner: campaign lead)

**The ordering invariant `residentSpendCeilingMicros < runBudgetCapMicros ≤ defaultKeyCapMicroUsd`
has one enforced term.** Asserted across six story files (DF2.3, DF2.4, DF2.8, DF3.6a, DF5.5, DF2.12)
and one **production docstring** (`src/providers/credentials.ts:46`, which promises DF3.6's
`loadResidentBounds` will assert against it).

Verified at source: `defaultKeyCapMicroUsd` is real and provider-enforced. `residentSpendCeilingMicros`
is the control DF3.6a exists to build. `runBudgetCapMicros` is declared **only** at
`scripts/cap-hit-demo.ts:97,148`, documented at `:1305` as *"Run budget cap (artifact field only,
default 40000)"* behind `--budget-cap` — it is written into DF2.4's evidence JSON and **enforces
nothing**. (`residentCeilingMicros` sits beside it with the same annotation.)

- **(a)** Give the per-run cap a real enforced home — a new config surface, a new enforcement site,
  a new failure mode, to satisfy an invariant written aspirationally.
- **(b)** *(recommended)* Collapse to `residentSpendCeilingMicros ≤ defaultKeyCapMicroUsd`, both real
  once DF3.6a ships, with DF2.8's per-issue cap named separately as governing **admission, not in-run
  enforcement** — the precedence already ratified for DF3.6. The run-budget number stays an evidence
  field in DF2.4's artifact, labelled as such.

Either way `credentials.ts:46`'s docstring must change; it promises a check nobody will write.
DF3.6a carries both options and a "do not implement `loadResidentBounds` against the chain until the
ruling lands" fence. Three of the six sites are **merged** stories — in-branch vs follow-up is a
second open question.

## Durable pattern adopted in 5c — self-proving greps

Any assertion of the form "grep returns zero matches" must pair with a **positive control on the
same file**: one pattern that MUST match. Control fails ⇒ report **unproven**, never **clean**.

Adopted after `scripts/lib/run-lock.ts` was found to contain two raw NUL bytes, which made `grep`
silently return nothing for *every* pattern — no error, exit 1, indistinguishable from "no matches"
— while DF2.11 and DF2.12 both asserted over that exact file with grep-authoritative DoD items.
The instance is fixed in **PR #238** (escape the bytes; they are a load-bearing cache-key separator
and must NOT be stripped). The pattern is the durable fix: it also defends against a moved file, a
wrong path, wrong flags, or a wrong working directory.

## Per-story finding counts

| Story | BLOCKER | HIGH | MEDIUM | LOW | Total | Done |
|---|---|---|---|---|---|---|
| DF3.6 | 6 | 6 | 7 | 4 | 23 | 0 |
| DF3.7 | 5 | 5 | 4 | 1 | 15 | 0 |
| DF3.8 | 3 | 5 | 3 | 1 | 12 | 0 |
| DF5.3 | 2 | 5 | 6 | 2 | 15 | 0 |
| DF5.4 | 3 | 5 | 4 | 2 | 14 | 0 |
| DF5.5 | 4 | 5 | 5 | 3 | 17 | 0 |
| DF6.1 | 5 | 7 | 8 | 6 | 26 | 0 |
| CC-A (3.7↔3.8) | 3 | 2 | 2 | — | 7 | 0 |
| CC-B (5.3↔5.4) | 2 | — | 4 | — | 6 | 0 |
| **TOTAL** | **33** | **40** | **43** | **19** | **135** | **0** |

Cross-story findings are counted in their own rows, not double-counted into the per-story rows.

## Where the full recipes live

This tracker is the **index and the status ledger**. The full finding — file+line, failure
scenario, and literal replacement text — lives in the scan report, one per agent. Fix agents
read the report section for their finding ID; they do not work from this table alone.

| Agent | Owns | Report | Lines |
|---|---|---|---|
| A | DF3.7 + DF3.8 | `_bmad-output/evidence/qds-story-review-2026-09-08/scan-A-df3-7-df3-8.md` | 1364 |
| B | DF5.3 + DF5.4 | `…/scan-B-df5-3-df5-4.md` | 1138 |
| C | DF3.6 | `…/scan-C-df3-6.md` | 1012 |
| D | DF6.1 | `…/scan-D-df6-1.md` | 1124 |
| E | DF5.5 | `…/scan-E-df5-5.md` | 689 |

Each report opens with a **"Verified-correct elements (SACRED)"** section: 13 items for DF3.7,
14 for DF3.8, 13 for DF3.6, 10 for DF5.3, 13 for DF5.4, plus DF6.1's and DF5.5's. Guardrail 4 —
no fix wave may regress a sacred item; a deliberate supersedure must be written down as such.

---

## Resolution status — Waves 0 through 4

**All 135 findings are ✅ DONE for agents A, B, D and E. Zero deferrals, zero `TODO`/`FIXME`.**
C (DF3.6) is completing under a mid-campaign mechanism change and a second story split.

The per-finding rows below are retained as the **index** — the ID, the one-line claim, and the
report that carries the recipe. They are not flipped individually; the authoritative resolution
record is each agent's report plus this section. Anything NOT resolved is named explicitly here.

| Agent | Files | Findings | Deferred | New found | Status |
|---|---|---|---|---|---|
| A | DF3.7, DF3.8 | 34 | **0** | 2 (both resolved same pass) | ✅ complete |
| B | DF5.3, DF5.4 | 35 | **0** | 4 (1 MEDIUM ratified + applied) | ✅ complete |
| C | DF3.6 → 3.6a/3.6b | 23 | 0 so far | 2 (1 dissolved by the cgroup ruling) | 🟡 split in progress |
| D | DF6.1 → 6.1a/6.1b | 26 | **0** | 2 (1 withdrawn with proof) | ✅ complete |
| E | DF5.5 | 17 | **0** | 4 (2 routed to parent) | ✅ complete |

**Standing requirement introduced mid-campaign, after B deferred 16 findings without recording
them:** any deferral must be stated **in the story text** with a reason and an owner. A reader of
the spec must never be unable to tell a resolved item from a pending one. Every agent met it on
the second pass; A closed its residues by naming an owner for each (reaper race → DF2.11 AC2(e),
reboot revisit threshold → arc owner at retro, F106 → DF5.1 scope) rather than deferring at all.

### Parent errors caught by agents, recorded (the campaign's own failure mode, in miniature)

Four of five agents successfully overruled a parent instruction. Recorded because the pattern —
reasoning from labels instead of reading the line — is exactly what produced the drift this
campaign exists to unwind.

| # | Parent said | Agent found | Why the agent was right |
|---|---|---|---|
| 1 | "DF6.1 — deps all shipped (DF5.2)" | Undeclared hard edge on DF3.7; declared edge on DF5.3 **unbuilt** | Read `run.ts`/`dispatch.ts`; DF6.1 is the *most* blocked story of the seven |
| 2 | DF5.5 fixed last, file-collision risk | Hardening its spec collides with nothing | Conflated spec-hardening with dev-time execution |
| 3 | RSS: reuse the `ps` sampler (Wave 0+1 brief) | Reversed to cgroup, **no sampler at all** | `memory.peak` is a kernel high-water mark — strictly better than any poll |
| 4 | P1.18 severance is DF6.1b | It is **DF6.1a** | `p1-18:50` is INV-2, about the payload *shape* and its consumer — parent reasoned from story titles |
| 5 | Severance stated in "exactly one half" | **Both** halves, limb-labelled | P1.18 had two relevances (intake vs verdict channel); the seam separated them |

### Cross-cutting resolutions, all applied

CC-1 canonical marker path · CC-2 claim-vs-truth sentence (both files, verbatim) · CC-3 tmpfs
reboot arms · CC-4 `unitActivity` reused, not re-authored · CC-5 cost attribution spec'd honestly
against #157 with a DF2.12 forward reference · CC-6 dependency edges · CC-7 three callers of
`observeAndDriveChain` (DF3.8, DF6.1a, operator) · CC-8 phantom symbols removed from both files.

**CC-B2 recurred one layer up and was caught in the fix itself:** giving C9 a `--json` payload to
assert against created a two-story wire format with no schema owner. Ratified — DF5.3 owns and
exports `ChainReport`, DF5.4-C9 imports it, reciprocity clause both ways, exported from the same
`src/audit/index.ts` surface as `OQ4_VOID_REASON` so a second export point cannot re-create it.

### A defect class this campaign named: orphaned work between two stories

DF5.5 removed the `p1-18:50` repoint from its edit list and handed it to DF6.1's wave. DF6.1a
described the severance but never claimed the **write**. The edit therefore had no owner and would
have silently never been performed — invisible to both stories, and green in both DoDs. Now owned
by DF6.1a with a one-line fence and a falsifiable DoD leg. Worth checking for wherever this
campaign hands an edit between stories.

### Citation discipline — the campaign's most common defect, and its fix

Stale line citations were the single most frequent finding across all five scans, and the campaign
kept generating them in real time: agent B cited the ADR at `:83-84` from the pre-Appendix file and
had to re-verify to `:81-82` after the parent's own edits shifted it; the parent had to apply DF5.5
amendment G by content match because E's line table had drifted within the hour. Convergent fix,
reached independently by three agents: **cite by symbol or section anchor, not by line.** Agent A
switched to `dispatch.ts`'s `provisionAdmittedRun`'s `within("create", …)`; ADR citations now use
Appendix A / Appendix B / §"In-box placement is load-bearing".

---

## Findings index

Status legend: ⬜ TODO · 🟡 IN_PROGRESS · ✅ DONE · ⏭️ DEFERRED · ❌ BLOCKED
*(Rows below are the index; see the Resolution status section above for what is done.)*

### DF3.7 — Approval-Gate Bridge (report A §2)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF3.7-B1 | BLOCKER | the marker path in this story does not exist | ⬜ |
| DF3.7-B2 | BLOCKER | AC4 mandates the one derivation the codebase forbids on the host leg | ⬜ |
| DF3.7-B3 | BLOCKER | `--await-completion` is attached to a verb that does not start the run | ⬜ |
| DF3.7-B4 | BLOCKER | AC2's four-kind classification contradicts the shipped classifier | ⬜ |
| DF3.7-B5 | BLOCKER | observer cannot tell "still running" from "engine died"; shipped code already can | ⬜ |
| DF3.7-H1 | HIGH | "fan-out has no poll-interval constant to inherit" is false | ⬜ |
| DF3.7-H2 | HIGH | the image-side amplifier called "filed, not fixed" has been fixed | ⬜ |
| DF3.7-H3 | HIGH | AC5's pre-flight refusal kills the gate's shipped `pausing` resume arm | ⬜ |
| DF3.7-H4 | HIGH | `reverify()` re-verifies the host's cwd; neither flag nor chain says so | ⬜ |
| DF3.7-H5 | HIGH | AC1's import fence is not falsifiable as worded, and may be unsatisfiable | ⬜ |
| DF3.7-M1 | MEDIUM | five stale or incorrect source citations | ⬜ |
| DF3.7-M2 | MEDIUM | `completedAt` optional on the wire, stated as required | ⬜ |
| DF3.7-M3 | MEDIUM | no exit code named for `run-completion-unobserved` | ⬜ |
| DF3.7-M4 | MEDIUM | live test's tier name violates the repo's tier grammar | ⬜ |
| DF3.7-L1 | LOW | dependency edges incomplete | ⬜ |

### DF3.8 — Host-Side Completion Watcher (report A §4)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF3.8-B1 | BLOCKER | inherits DF3.7's defective contract and declares it FINAL | ⬜ |
| DF3.8-B2 | BLOCKER | **shipped-code gap** — reaper takes no run lock; AC2's mutex excludes the wrong process | ⬜ |
| DF3.8-B3 | BLOCKER | a rebooted box becomes a permanent candidate the sweep measures then discards | ⬜ |
| DF3.8-H1 | HIGH | documented cron line must set cwd or every tick reverifies the wrong tree | ⬜ |
| DF3.8-H2 | HIGH | AC2(c)'s two-observer exclusion collapses if DF3.7 moves off `fleet dispatch` | ⬜ |
| DF3.8-H3 | HIGH | every reaper citation in "Correction of record" is wrong | ⬜ |
| DF3.8-H4 | HIGH | `observe` exit table under-specified against DF3.5's contract test | ⬜ |
| DF3.8-H5 | HIGH | AC3's `completion-unwitnessed` arm unreachable under AC2(a)'s filter | ⬜ |
| DF3.8-M1 | MEDIUM | eight stale line citations | ⬜ |
| DF3.8-M2 | MEDIUM | `max-candidates-per-pass` bounds a count, not wall clock | ⬜ |
| DF3.8-M3 | MEDIUM | `hostNow` read-time unspecified in the uptime arithmetic | ⬜ |
| DF3.8-L1 | LOW | dependency edges | ⬜ |

### CC-A — DF3.7 ↔ DF3.8 contract (report A §5)

| ID | Sev | One line | Status |
|---|---|---|---|
| CC-A1 | BLOCKER | writer and reader agree with each other and both disagree with the substrate | ⬜ |
| CC-A2 | BLOCKER | "FINAL, consumed unchanged" is false in both directions | ⬜ |
| CC-A4 | BLOCKER | pair cannot distinguish completed / died / never-written; primitive already exists | ⬜ |
| CC-A3 | HIGH | "re-observing is idempotent because the marker is the state" false after the chain runs | ⬜ |
| CC-A5 | HIGH | the two time domains do not compose | ⬜ |
| CC-A6 | MEDIUM | exit-code grammar specified on one side only | ⬜ |
| CC-A7 | MEDIUM | observability keys join, but one field missing on the DF3.7 side | ⬜ |

*(CC-A8 / CC-A9 came back verified-correct: security invariants clean, ADR conformance exact.)*

### DF3.6 — Resident-Agent Bounds (report C)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF3.6-B1 | BLOCKER | engine cannot obtain the resident's root pid — RSS watchdog unimplementable in scope | ⬜ |
| DF3.6-B2 | BLOCKER | AC2a compares two values the in-box engine cannot read (permanent false green) | ⬜ |
| DF3.6-B3 | BLOCKER | `runBudgetCapMicros` does not exist; DF2.8 ships a per-issue cap | ⬜ |
| DF3.6-B4 | BLOCKER | the per-phase iteration bound is structurally unreachable | ⬜ |
| DF3.6-B5 | BLOCKER | the MANDATORY e2e demo's arithmetic is impossible (504 µ$ vs narrated 900,000) | ⬜ |
| DF3.6-B6 | BLOCKER | Files to Modify forbids four edits the ACs require | ⬜ |
| DF3.6-H1 | HIGH | reinvents a shipped RSS watchdog and gets the platform dispatch wrong | ⬜ |
| DF3.6-H2 | HIGH | the sampler has no process to sample for most of the run | ⬜ |
| DF3.6-H3 | HIGH | no baseline/scoping rule; the bound will trip on tier-3 workers | ⬜ |
| DF3.6-H4 | HIGH | at shipped rates the "absolute spend ceiling" cannot fire | ⬜ |
| DF3.6-H5 | HIGH | a bound firing against an already-degraded resident is undefined | ⬜ |
| DF3.6-H6 | HIGH | AC3 bounds a quantity the code does not count | ⬜ |
| DF3.6-M1 | MEDIUM | the Hardening Revision "fixed" a citation that was correct | ⬜ |
| DF3.6-M2 | MEDIUM | F7 tripwire (a) left undecidable | ⬜ |
| DF3.6-M3 | MEDIUM | F7 tripwire (c) has a cardinality-1 cause and cannot recur in a run | ⬜ |
| DF3.6-M4 | MEDIUM | the AC2b clamp journal row has no home | ⬜ |
| DF3.6-M5 | MEDIUM | the tripwire row shape omits required fields | ⬜ |
| DF3.6-M6 | MEDIUM | 3 points and a 5-file budget are no longer honest | ⬜ |
| DF3.6-M7 | MEDIUM | dependency edges omit DF1.10 and DF1.11 | ⬜ |
| DF3.6-L1 | LOW | `"overflow"` never cited to a file | ⬜ |
| DF3.6-L2 | LOW | the darwin justification is stale | ⬜ |
| DF3.6-L3 | LOW | `.strict()` schema not noted | ⬜ |
| DF3.6-L4 | LOW | AC2b's second negative control is now a tautology | ⬜ |

### DF5.3 — Audit Chain Extended (report B §DF5.3)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF5.3-B1 | BLOCKER | hops 2 and 9 resolve against a trace store that is no longer host-side | ⬜ |
| DF5.3-B2 | BLOCKER | hop 3's per-role split unobtainable; token bridge declared, not wired (#157) | ⬜ |
| DF5.3-H1 | HIGH | `readRunCost` is a class method, and constructing the ledger writes | ⬜ |
| DF5.3-H2 | HIGH | the emitter file map points at the wrong files | ⬜ |
| DF5.3-H3 | HIGH | "no exported signature changes" is false, and load-bearing for the estimate | ⬜ |
| DF5.3-H4 | HIGH | there is no "cap" credential event to hook | ⬜ |
| DF5.3-H5 | HIGH | the `requestId` join contradicts shipped code, in DF5.3's own name | ⬜ |
| DF5.3-M1 | MEDIUM | `<host_data_dir>` does not exist | ⬜ |
| DF5.3-M2 | MEDIUM | `extensions.fixLoop.fixOutcome` is a string, not an object | ⬜ |
| DF5.3-M3 | MEDIUM | `unlinked` is unclassified: complete or broken? | ⬜ |
| DF5.3-M4 | MEDIUM | AC1's record shape contradicts AC5 and hop 10 | ⬜ |
| DF5.3-M5 | MEDIUM | `evidence_digest` never protects the records that authorize the PR | ⬜ |
| DF5.3-M6 | MEDIUM | `qds audit` is not an invocable command | ⬜ |
| DF5.3-L1 | LOW | (see report) | ⬜ |
| DF5.3-L2 | LOW | (see report) | ⬜ |

### DF5.4 — Lights-On Exit Gate (report B §DF5.4)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF5.4-B1 | BLOCKER | `.sandbox/approvals/<id>.json` does not exist — C7 skips on every healthy run forever | ⬜ |
| DF5.4-B2 | BLOCKER | C3/C4 assert in-box claims as proof, contradicting INV-GATE-4 and the ADR | ⬜ |
| DF5.4-B3 | BLOCKER | C10 writes; INV-GATE-1's "only write is the report file" is false | ⬜ |
| DF5.4-H1 | HIGH | E2E slice and mandatory DoD e2e contradict AC4 and INV-GATE-5 | ⬜ |
| DF5.4-H2 | HIGH | `readRunCost` is a class method, not a module export | ⬜ |
| DF5.4-H3 | HIGH | C9 asserts only an exit code | ⬜ |
| DF5.4-H4 | HIGH | dependency edges stale in a load-bearing way | ⬜ |
| DF5.4-H5 | HIGH | "the lights-on run of record" has no producer and is not producible today | ⬜ |
| DF5.4-M1 | MEDIUM | `<host_data_dir>` does not exist | ⬜ |
| DF5.4-M2 | MEDIUM | C1 names no evidence and duplicates the preflight | ⬜ |
| DF5.4-M3 | MEDIUM | no clause orders approval before the PR | ⬜ |
| DF5.4-M4 | MEDIUM | C2's "record closed" satisfied by a paused, never-approved run | ⬜ |
| DF5.4-L1 | LOW | (see report) | ⬜ |
| DF5.4-L2 | LOW | (see report) | ⬜ |

### CC-B — DF5.3 ↔ DF5.4 contract (report B §CC)

| ID | Sev | One line | Status |
|---|---|---|---|
| CC-B1 | BLOCKER | the two halves disagree on the ADR's two-layer evidence doctrine | ⬜ |
| CC-B2 | BLOCKER | nothing DF5.3 emits is asserted by anything but an exit code | ⬜ |
| CC-M1 | MEDIUM | DF5.4 asserts an ordering DF5.3's chain cannot express | ⬜ |
| CC-M2 | MEDIUM | "the chain is reconstructable" means two different things | ⬜ |
| CC-M3 | MEDIUM | both halves share the same two phantom symbols | ⬜ |
| CC-M4 | MEDIUM | the VOID reason strings are claimed identical and are not | ⬜ |

### DF6.1 — PR Feedback → Bounded Fix Run → CI Green (report D)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF6.1-B1 | BLOCKER | undeclared hard dependency on DF3.7 (and DF3.8 for the unattended claim) | ⬜ |
| DF6.1-B2 | BLOCKER | single-fixer guard inverted against DF1.5's shipped roster type (`null` = unrestricted) | ⬜ |
| DF6.1-B3 | BLOCKER | the CI-verdict query cannot answer the question AC3 asks of it | ⬜ |
| DF6.1-B4 | BLOCKER | `extensions.fixLoop` already registered with a contradicting shape; validator bricks on real comment text | ⬜ |
| DF6.1-B5 | BLOCKER | the loop has no named driver; the two readings are incompatible | ⬜ |
| DF6.1-H1 | HIGH | the inherited-seam briefing now recommends an ADR violation | ⬜ |
| DF6.1-H2 | HIGH | fix brief's `issueId` required and unspecified; budget arithmetic left to dev | ⬜ |
| DF6.1-H3 | HIGH | mandatory e2e demo has no path, tier, gate, spend estimate or environment | ⬜ |
| DF6.1-H4 | HIGH | DF5.3 is a declared predecessor and is not shipped; AC6 unbuildable today | ⬜ |
| DF6.1-H5 | HIGH | INV-3's credential probe is a narrow check sold as a mechanical guarantee | ⬜ |
| DF6.1-H6 | HIGH | refusals/non-success not distinguished from "the fix was wrong" | ⬜ |
| DF6.1-H7 | HIGH | `pushVerifiedSha` has a third return arm the story never handles | ⬜ |
| DF6.1-M1 | MEDIUM | attempt-budget CAS invents a second concurrency primitive | ⬜ |
| DF6.1-M2 | MEDIUM | 40 KB payload on a run record with no length bound, re-read every sweep | ⬜ |
| DF6.1-M3 | MEDIUM | AC1 asserts an agent-authored claim as if it were evidence | ⬜ |
| DF6.1-M4 | MEDIUM | poll window can open before any check exists — "all settled" vacuously true | ⬜ |
| DF6.1-M5 | MEDIUM | "refuses a PR with no required checks" asserted three times with no mechanism | ⬜ |
| DF6.1-M6 | MEDIUM | the Overview's chain omits `fleet run` | ⬜ |
| DF6.1-M7 | MEDIUM | DF13 fleet-ceiling TOCTOU note carried forward without re-verification | ⬜ |
| DF6.1-M8 | MEDIUM | briefing item 1's premise stale, its OPEN QUESTION now answerable | ⬜ |
| DF6.1-L1..L6 | LOW | six items — see report §LOW | ⬜ |

### DF5.5 — KEEP-Repoint Chore (report E)

| ID | Sev | One line | Status |
|---|---|---|---|
| DF5.5-B1 | BLOCKER | `sprint-status.yaml` orphaned — file says DF5.5 owns its repoints, DF5.5 says it doesn't | ⬜ |
| DF5.5-B2 | BLOCKER | INV-1 forbids the edits amendment A prescribes on five lines | ⬜ |
| DF5.5-B3 | BLOCKER | the `p1-18:50` repoint writes an edge DF6.1 explicitly denies | ⬜ |
| DF5.5-B4 | BLOCKER | amendment C's P1.9 blockquote states a fact P1.9's own text contradicts | ⬜ |
| DF5.5-H1 | HIGH | the DoD's mechanical check does not scan the artifact most likely to be wrong | ⬜ |
| DF5.5-H2 | HIGH | `p1-9`'s dependency edge disagrees with itself; DF5.5 repoints only one side | ⬜ |
| DF5.5-H3 | HIGH | repointing the ID without the module path leaves P1.11/P1.12 at a directory v5 doesn't build | ⬜ |
| DF5.5-H4 | HIGH | the `p1-18` narrative repoints write DF-era IDs into a mechanism DD-1 killed | ⬜ |
| DF5.5-H5 | HIGH | the slate is 37 stories / 151 points; DF5.5 says 31 | ⬜ |
| DF5.5-M1 | MEDIUM | bare ID substitution leaves false descriptive glosses | ⬜ |
| DF5.5-M2 | MEDIUM | `p1-3`'s eight repointed lines all describe the unbuilt `/api/a2a` surface | ⬜ |
| DF5.5-M3 | MEDIUM | `p0-9:218` is an allocation record, not a forward-looking edge | ⬜ |
| DF5.5-M4 | MEDIUM | the R5 citation is an unresolvable bare filename | ⬜ |
| DF5.5-M5 | MEDIUM | `tests/backlog/` is a new top-level test dir with no sibling convention | ⬜ |
| DF5.5-L1 | LOW | amendment D's "DF2.8's cost view" clause is counterfactual | ⬜ |
| DF5.5-L2 | LOW | "eleven KEEP stories" over-counts by construction | ⬜ |
| DF5.5-L3 | LOW | the epics index is stale about DF6 and is a silent marker-grep participant | ⬜ |

---

## Wave 5 calibration — SEALED until the verifiers report

The DF6.1 author self-identified two spots where it judged an unbriefed reviewer more reliable
than itself. **These are deliberately withheld from the Wave 5 verifier prompts.** Briefing a
verifier with author uncertainty narrows its attention as surely as briefing it with fix recipes
would, and Wave 5's whole value is beginner's mind.

They are recorded here instead as a **calibration test of the verification wave itself**:

1. **`commentsDigest` is defined post-redaction** — SHA-256 over canonical JSON of the ordered
   `[{commentId, bodySnippet}]` array *after* `redactSecrets` runs. This makes the digest a
   function of the redactor's current behaviour, so changing `redactSecrets` renders every
   historical digest unreproducible. The author believes this is correct (the digest should attest
   what the fixer actually saw, not what GitHub stored) but made the call alone.
2. **DF6.1a AC1's second negative control** — "an implementation that drives the pi worker argv
   from the host MUST fail." The control is asserted; *how a test proves locality* is not
   specified. The author flagged this as structurally the same gap the ADR's forensics records:
   no AC in the original DF3.3 tested locality, which is exactly how the tier-2 deviation survived
   seven review rounds and ~260 findings.

**Reading the result.** If Wave 5 finds these independently → the verification is doing real work
and its other findings carry weight. If it misses them → the parent raises them directly, and the
campaign has learned something quantitative about what a fresh-eyes pass is worth here. Either
outcome is informative; only pre-briefing them would have destroyed the measurement.

Both are already stated in the story text, so a verifier reading the file has everything it needs
to find them. Neither is a hidden deferral.

---

## Cross-cutting themes (Wave 0 — resolved FIRST, parent locks the canonical answer)

Each theme spans ≥2 stories. The parent locks the canonical resolution, then routes each pair's
portion to the agent that owns those files. No agent sees another pair's portion.

### CC-1 — The completion-marker path and its classifier grammar
**Spans DF3.7, DF3.8, DF6.1, and (by sibling mechanism) DF5.3.**
Specs use `/run/journal/final.json`. Shipped is `/run/qds-run/<runId>/journal/final.json` (#217
F-D1), enforced in five places including the unit's `RuntimeDirectory=qds-run/%i/...`. The old
path is not merely stale — it now *means* `unidentifiedMarkerPath()`, the fail-closed shared
root for identity-less invocations. Also carries DF3.7-B4's classifier grammar (`unreadable` is
`unusable` and counted, `absent` splits on `probeExit`, `skip` + `PROBE_SKIP_TICKS_LIMIT`=6 are
absent from the spec, `expectedRunId` never required).
**Feeds:** DF3.7-B1/B2/B4/M2/M3, DF3.8-B1, CC-A1, CC-A6, DF6.1-B1.

### CC-2 — In-box claim ≠ host-verified fact (R9 two-layer doctrine)
**Spans DF5.3, DF5.4, DF3.7, DF3.8.**
The engine now runs in-box and emits *claims*; DF5.1 host re-verify is the independent second
layer. DF5.3's INV-AUDIT-5 types this correctly; DF5.4's C3/C4 assert an in-box claim as a pass
condition, collapsing both layers into one trust domain — the exact doctrine the ADR exists to
protect. One contract, two trust models.
**Feeds:** CC-B1, DF5.4-B2, DF5.3-B1.

### CC-3 — `/run` is tmpfs; a reboot wipes it
**Spans DF3.7, DF3.8, DF5.3.**
Measured in the 2026-08-31 probe and re-proven live by DF1.11b. A rebooted box writes no marker
ever (`Type=simple`, `Restart=no`, no `[Install]`) yet stays at the head of the sweep's
oldest-first ordering forever; two audit hops become permanently unresolvable on a run that
*succeeded*, because the trace DB reaches the host only inside teardown's deliberately
non-fatal artifacts tar.
**Feeds:** DF3.8-B3, DF5.3-B1, DF3.7-B5.

### CC-4 — Liveness: the four meanings of an absent marker
**Spans DF3.7, DF3.8, DF6.1.**
The pair cannot distinguish *completed* / *died* / *never-written* / *rebooted*. **The primitive
already ships** — `unitActivity`, whose own docblock enumerates exactly those four meanings, and
which `fleet status` already consumes. Ladder rung 2: reuse it; do not author a liveness arm.
Fixes for DF3.7-B5 and DF3.8-B3 must land together or each re-opens the other.
**Feeds:** CC-A4, DF3.7-B5, DF3.8-B3, DF6.1 unobserved arm.

### CC-5 — Cost and spend attribution is unbacked in production
**Spans DF3.6, DF5.3, DF5.4.**
`ingestCostEvent` is the only writer of `tokens` rows and has **zero non-test callers**
(issue #157, open) — production runs write box-hours only. `runBudgetCapMicros` exists in no
code. `readRunCost` is a class method whose constructor *writes* (mkdir 0700, create DB, chmod,
`PRAGMA journal_mode=WAL`, `db.exec(SCHEMA)`), so three specs that call it "a read" are wrong
and one of them (DF5.4-B3) builds an invariant on the claim.
**Feeds:** DF5.3-B2, DF5.3-H1, DF3.6-B2, DF3.6-B3, DF3.6-H4, DF5.4-B3, DF5.4-H2.

### CC-6 — The dependency graph is wrong for five of the seven stories
**Spans everything + `sprint-status.yaml`. Parent owns; DF5.5 owns the yaml rows.**
DF6.1 has an undeclared hard edge on DF3.7 and a declared edge on DF5.3 that is **unbuilt**
(`src/audit/` does not exist) — it is the most dependency-blocked story of the seven, not the
least. DF5.3 needs DF1.10 + DF2.6. DF5.4 needs DF1.10, DF2.5-direct, DF3.7, DF3.8. DF3.6 omits
DF1.10 and DF1.11. Eight phase-1 KEEP rows still carry retired IDs in their `deps:` arrays.
**Feeds:** DF6.1-B1, DF6.1-H4, DF5.4-H4, DF3.6-M7, DF3.7-L1, DF3.8-L1, DF5.5-B1.

### CC-7 — `observeAndDriveChain` will have three callers, not two
**Spans DF3.7, DF3.8, DF6.1.**
DF3.8's sweep, DF6.1a's fix run, and the operator. DF3.7's pending INV-IBOX-16 reword must be
written for three callers; DF3.8's AC2(c) two-observer exclusion argument assumes two.
**Feeds:** CC-A2, DF3.8-H2, DF6.1-B1.

### CC-8 — Phantom symbols shared across specs
**Spans DF5.3, DF5.4.** `<host_data_dir>` and an "exported `readRunCost`" appear in both and
exist in neither. Fix once, in one pass, not twice.
**Feeds:** DF5.3-M1, DF5.4-M1, CC-M3.

---

## Structural proposals (full authority granted 2026-09-08 — executed after Wave 0)

| # | Change | Rationale | Status |
|---|---|---|---|
| S1 | **Split DF6.1 at the `attemptSha` seam** → DF6.1a "PR Feedback → Bounded Fix Attempt → Verified Append" (4 pt, AC1/2/5, deps +DF3.7) and DF6.1b "Fix-Loop CI Verdict, Attempt Budget and Human Escalation" (3 pt, AC3/4/6, deps DF6.1a + DF5.3). 6 → 7 pts. | The seam is the story's own durable contract — `fixContext` written once, after `pushVerifiedSha` returns. It also splits the live spend cleanly: a's e2e needs a box and a key, b's needs neither, so the termination matrix can be exercised exhaustively for free. | ⬜ |
| S2 | **Re-estimate** DF5.3 4→6, DF5.4 3→5, DF5.5 2→3, DF3.6 3→TBD (M6). | Each premise that justified the original number was falsified by a code read — DF5.3's "single-line emits, no signature changes" fails because providers use injected `*Deps` seams; DF5.5's edit volume grew ~50% via the ADR arc. | ⬜ |
| S3 | **Re-sequence DF5.4 last in v5-S3.** | Its "lights-on run of record" has no producer until DF3.7/DF3.8 exist (DF5.4-H5). | ⬜ |
| S4 | **Re-point dependency edges** per CC-6, in both the story headers and `sprint-status.yaml`. | The graph currently mis-states what is startable. | ⬜ |
| S5 | **Hand `p1-18:50` from DF5.5 to DF6.1's fix wave**; route DD-2's register addendum to the ADR-amendment output. | DF6.1 owns the severance and already states it; two owners writing one edge is how a repoint gets reverted. | ⬜ |

Net slate effect if all execute: 37 → 38 stories, 151 → 158 points (7 remaining → 33 pts).

---

## ADR amendments — BOTH RATIFIED ACCEPTED (operator, 2026-09-08)

Written into `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` as **Appendix A** and
**Appendix B**, with pointers added at the original clauses (mechanism (2) and Consequence 4).
Appended, not rewritten in place: an ADR is a record of what was decided and when, and in a repo
whose DF5.3 story is *about* a reconstructable audit chain, silently editing decision history would
be the wrong precedent. Both are clarifications; the Decision, the five load-bearing mechanisms and
the Re-opening criteria all stand unchanged.

**Appendix A — Consequence 4: the marker is a run-completion signal, not an approval state.**
Ratified largely on the strength of the *alternative*: leaving it meant DF3.7 and DF3.8 each
carrying a standing story-local Deviation against an ACCEPTED clause — verbatim the shape the ADR's
own forensics (`:19-23`) blame for the original silent deviation. Both deviation entries are being
deleted from the stories by the Wave 0+1 fix agent; the record now lives at an operator gate.

**Appendix B — mechanism (2): a bound on component X is rooted at X's pid, never at an ancestor's.**
Ratified **stronger than the reviewer proposed.** The scan's text said the engine "can *enumerate*
the resident's own subtree"; that was judged too weak — enumeration is a capability claim and F12
needs an *enforcement* claim — and it was scoped as a note about tier-3 workers rather than as a
general invariant. DF3.6 is the first bound, not the last, so the invariant is stated generally.

**Consequent mechanism ruling (operator, 2026-09-08): the resident's memory bound is
cgroup-enforced, not `ps`-sampled.** A multi-second sampler cannot bound *peak* RSS — a process
balloons and OOMs the box between samples and the sampler reports it afterwards, which is a
band-aid for what the ADR calls an enforcement bound. systemd is PID 1 on the box (measured,
2026-08-31 probe) and DF1.10 ships a per-run unit, so cgroup v2 `MemoryMax=` is available,
kernel-enforced, un-bypassable from inside, and deterministic. Sampling is retained for telemetry
and attribution only. This **deliberately re-opens and supersedes DF5.1's standing accepted
ceiling** ("RSS is `ps`-sampled rather than cgroup-enforced") rather than letting a second story
inherit it — two stories inheriting one ceiling is how a ceiling becomes permanent. Cost is
acknowledged in the ADR text, not papered over: pi is spawned by the engine via `Bun.spawn`, not by
systemd, so scoping requires `systemd-run --scope` per solicitation or a direct cgroup-fs write.
This **overrides** the scan's own recommendation to reuse `src/reverify/worktree.ts`'s sampler; the
DF3.6 fix agent was redirected mid-flight.

## Superseded — the original PROPOSED forms (retained for provenance)

**No shipped code contradicts the tier-2 placement ADR.** All 135 findings are spec-side drift
against ADR-consistent code. That is itself the campaign's most reassuring result: the
restoration arc built what the ADR said.

### PROPOSED-ADR-A1 — Consequence 4: "awaiting marker" → "completion marker" (editorial)
Full text in report A §6. Both DF3.7 and DF3.8 currently carry this as a *story-local Deviation
against an ACCEPTED clause* — structurally the same shape the ADR's own forensics blame for the
original silent deviation. Amend the ADR by appendix rather than let two stories quietly deviate.

### PROPOSED-ADR-C1 — Tighten Consequence/mechanism (2)'s "shared process tree"
Full text in report C. In-box, the engine also parents tier-3 `dispatch_task` workers
(`QDS_TEAM_RUNNER=local`), so "shared process tree" is satisfied by an implementation that
charges the whole subtree to the resident's 512 MiB bound — the F064 defect already fixed once
in `worktree.ts:293-299`. Proposed wording: *"can enumerate the resident's own subtree, rooted
at the resident's pid, never the engine's."*

---

## Code follow-ups — RATIFIED DISPOSITION (operator, 2026-09-08)

All four were **independently verified against source by the parent**, not accepted on an agent's
say-so. Operator ruling: they land as **properly-planned DF stories**, not drive-by patches.

| Item | Verified how | Lands as |
|---|---|---|
| F1 teardown run-lock | `src/providers/reaper.ts` has **zero** lock references; bare `teardownSandbox(teardownDeps, unit.id)` at `:726`; seven call sites enumerated | **DF2.11** (~3 pt) |
| F3 read-only ledger | `src/providers/cost-ledger.ts:874-915` — constructor mkdirs 0700, chmods, `new Database()` **creates the file**, asserts modes | **DF2.11** (same story) |
| F4 token attribution | `ingestCostEvent` at `:961`; only test callers; codebase documents the hole at `qds-cost.ts:396`, `cost-ledger.ts:1438`, and names the fix at `:1458` | **DF2.12** (~3 pt) |
| F2 `assertNoSecret` | `run-record.ts:685-712` throws on any `SECRET_PREFIXES` hit at a token boundary | **folded into DF6.1a** — a design decision, not a patch |

**F1 is the most severe of the four and it is data loss, not a nuisance.** Teardown is harvest →
destroy → revoke → `closedAt`, and harvest is the *only* path work leaves a box because D8 forbids
a push credential in-box. Two concurrent teardowns means the second finds the box destroyed and the
bundle is gone, irreversibly, on a run that may have succeeded. Trigger: `sandbox-reap --yes`
during a sweep. **Fix is at the shared function, not the reaper** — seven callers exist and DF3.7
is about to add an eighth, so per-caller discipline is exactly how the eighth forgets. Ratified
design: `teardownSandbox` takes a required `RunLockHandle`, making the unlocked call **fail to
compile**; non-holders go through `withRunLock(...)`. Not a boolean flag — booleans lie, handles do
not — and holding the handle is also what resolves the non-re-entrant `acquireRunLock` problem.

**F3 is structural, not tidiness.** DF5.4's gate is R9's *independent* second evidence layer, and a
verifier that mutates what it verifies is not independent. It also **creates** an absent ledger, so
a gate run on a fresh host manufactures an empty one and can read zero spend as within budget —
`INV-COST-6` guards *unopenable*, not *absent*. Fix direction is deliberately **code moves to the
spec**: `openReadOnly()` refuses an absent file, opens readonly, mutates nothing, and DF5.4's
`INV-GATE-1` becomes true rather than being weakened to match the code.

**F4 is a disarmed governance control, not debt.** D4 tripwire (a) — *"resident-agent token spend
> 15% of run total at p50"* — is one of three conditions that **demote tier 2 entirely**, and it is
undecidable with no `kind='tokens'` rows. DF3.6's absolute spend ceiling has the same dependency.
**DF2.12 is therefore a hard predecessor of DF3.6**, not a parallel issue.

**F2's root cause is the storage design, not the ordering.** `assertNoSecret` is a *working*
security control and stays untouched; the defect is DF6.1 pushing raw third-party PR comment text
through a closed, secret-scanned run record — false-positive throws on a reviewer legitimately
writing "don't hardcode `sk-`…", unbounded length (DF6.1-M2's 40 KB payload re-read every sweep),
and untrusted external content inside the record DF5.3 must prove reconstructable. Ratified: store
a **content digest + the GitHub comment IDs** (already the dedupe key); prose goes to the harvested
artifacts path with its own redaction, if at all. Plus a general invariant added to DF6.1a: *any
validation that can refuse MUST run before the irreversible action* — pre-flight the record write
before `pushVerifiedSha`, never after.

Slate effect: **+2 stories / +6 pts** (DF2.11, DF2.12), on top of S1's DF6.1 split.

## Original follow-up table (as first collated)

| # | Item | Evidence | Disposition |
|---|---|---|---|
| F1 | **The reaper takes no run lock** — `reaper.ts:726` calls `teardownSandbox` directly, so `sandbox-reap --yes` during a sweep races two teardowns on one box. Real today. | DF3.8-B2 | ⬜ operator — file issue |
| F2 | `assertNoSecret`'s prefix scan (`sk-`, `ghp_`, `-----BEGIN`) throws on ordinary bot-comment text — **after** `pushVerifiedSha` returns, i.e. after the irreversible push. | DF6.1-B4 | ⬜ operator — file issue |
| F3 | `CostLedger` has no read-only constructor; any reader mkdirs, creates, chmods and WALs the DB. Weakens the second evidence layer's independence. | DF5.4-B3, DF5.3-H1 | ⬜ operator |
| F4 | `ingestCostEvent` has zero non-test callers — design §6's per-run cost attribution is unbacked. | issue #157 (open), DF5.3-B2 | ⬜ already filed |
| F5 | `scripts/install-gitnexus-plus.sh` arch guard read the *process* arch under a Rosetta'd `/usr/local/bin/bash`, disabling `--embeddings` on Apple Silicon and degrading every index to BM25-only. | this session | ✅ FIXED (`sysctl -n hw.optional.arm64`) |

---

## Session log

- **2026-09-08 — pre-campaign status audit.** DF1.11 and DF3.5 flipped to `done` against git
  history (PRs #232/#233/#234/#236/#237 and #185); meta counter recomputed to 30/37, 125/151.
- **2026-09-08 — Wave: dependency analysis.** ADR + design-doc §4/§5.1 + shipped-arc state
  read; pairing plan A–E recorded above; tracker created.
- **2026-09-08 — Wave: initial scan dispatched.** 5 adversarial reviewers (A–E), reports to
  `_bmad-output/evidence/qds-story-review-2026-09-08/`.
- **2026-09-08 — Initial scan COMPLETE. 135 findings: 33 BLOCKER / 40 HIGH / 43 MEDIUM / 19 LOW**
  across 5,327 lines of report. Eight cross-cutting themes identified (CC-1…CC-8), five structural
  proposals (S1–S5), two PROPOSED ADR amendments, five code follow-ups.
  **Headline result: no shipped code contradicts the ADR.** Every finding is spec-side drift against
  ADR-consistent code — the restoration arc built what the ADR specified. What rotted is the seven
  specs that were written before it existed.
  Three findings justify the campaign's whole premise on their own:
  - **CC-A1** — DF3.7 and DF3.8 agree with *each other* on `/run/journal/final.json` and both
    disagree with the substrate (`/run/qds-run/<runId>/journal/final.json`). An internally-consistent,
    externally-wrong contract: unreachable by cross-checking the two stories against each other, and
    worse than stale — the old path now *means* `unidentifiedMarkerPath()`.
  - **CC-B2** — nothing DF5.3 emits is asserted by anything but an exit code. An empty `audit_links`
    table walks the lights-on gate green.
  - **DF3.6** — the ADR predicted this story's in-box clauses would "become correct again," and they
    did (8 CORRECT-NOW / 4 wrong-mechanism / 1 stale). But **every one of its six BLOCKERs lives
    outside the passage the ADR cited.** Reading only the cited lines would have caught one of six.
- **2026-09-08 — Correction to the dispatch plan (parent error, recorded).** The pairing plan stated
  "DF6.1 — deps all shipped (DF5.2)." Wrong twice: DF6.1 has an **undeclared hard edge on DF3.7**, and
  its declared edge on DF5.3 is **unbuilt** (`src/audit/` does not exist). DF6.1 is the most
  dependency-blocked story of the seven, not the least. Caught by agent D against code, not by the
  parent's graph read of the story headers — which is the failure mode CC-6 now tracks.
- **2026-09-08 — Correction to the sequencing plan (parent error, recorded).** DF5.5 was scheduled to
  be *fixed last* on file-collision grounds. That conflated two different things: hardening DF5.5's
  spec edits only `df5-5-keep-repoint-chore.md` and collides with nothing. What must run last is
  DF5.5's **dev-time execution**, which is a property of the story, not of this campaign. E runs in
  parallel with A–D.
- **2026-09-08 — Toolchain fix (F5).** `gitnexus analyze` failed on an inconsistent `file_fts` index;
  `--repair-fts` cleared it and revealed the previous run had also left `incrementalInProgress` set.
  Reindex clean at `fa7d0e2` (17,680 nodes / 35,734 edges / 849 clusters / 300 flows), CLI 1.6.9 ==
  pin. Root-caused a second, quieter defect while there: `scripts/install-gitnexus-plus.sh`'s arch
  guard read `uname -m`, which under the Rosetta'd x86_64 `/usr/local/bin/bash` first on PATH answers
  `x86_64` on an Apple Silicon M2 — so **every index this repo has built was silently degraded to
  BM25-only**, exactly the mode whose own warning says "gitnexus_query may miss symbol-name-only
  hits." Guard now also consults `sysctl -n hw.optional.arm64`, which is the machine fact and is
  Rosetta-proof. Re-indexed with `--embeddings`.
  **That fix then exposed a third defect:** the 300s analyze cap had been tuned against the
  no-embeddings path — the only path this repo had ever taken — and aborted the real one mid-write
  at ~390s (`exit=142`, SIGALRM). Raised to 600s at all three sites. Also observed and marked with
  its ceiling: the `perl` fallback kills only the wrapper, so `gitnexus`'s node child ran on ~90s
  past the abort and finished a clean index anyway; upgrade path (`setpgrp` + `kill -- -$$`) noted
  in the comment rather than built, since `timeout`/`gtimeout` already kill the process group.
- **2026-09-08 — Wave 0+1 DISPATCHED.** 5 agents on the scan partition (A: DF3.7+DF3.8, B:
  DF5.3+DF5.4, C: DF3.6, D: DF6.1 incl. the S1 split, E: DF5.5). Wave 0 and Wave 1 merged into one
  pass per agent: the cross-cut resolutions are locked in each prompt and each agent owns its files
  exclusively, so a separate Wave 0 would have bought coordination the prompts already guarantee.
- **2026-09-08 — WAVE 6 COMPLETE. 90 findings. VERDICT: NOT CONVERGED.** Five fresh verifiers,
  no fix recipes, each classifying by category as well as severity. **C3-structural 31 (34%) vs
  C4-marginal 13 (14%)** — the count fell (135→125→90) and the category did not. Full analysis in
  the Wave 6 section above. The recommendation is explicitly **not a fourth patch round**: the C3
  class is substantially iatrogenic (orphaned work across seams *this campaign cut*, residues dead
  from edges *this campaign added*, a third wrong derivation of a number two fix waves rewrote), so
  another prose pass would operate on specs whose defects are being generated by the patching.
- **2026-09-08 — Parent-owned queue, closed. Every item verified at source before acting; two of the
  six handed-over claims were WRONG and are corrected here rather than propagated.**
  1. **N7 (fixed).** `tier2-dispatch-engine.live.test.ts` cited `cost-ledger.ts:753` for
     `ingestCostEvent`. Opened it: `:753` is a blank line between `AdmissionInput` and
     `AdmissionDecision`; the method is at `:961`. Re-cited by symbol.
  2. **The `no-ceiling` arm — the handoff was WRONG.** It claimed the arm at `dispatch.ts`'s
     `effectiveCeilingMicros` guard is now *reachable* because upgrade trigger 1 fired. Trigger 1 did
     fire — `assertWithinBudget`'s third parameter **is** `keyCapMicroUsd` and dispatch passes
     `deps.capMicroUsd` into it — so the comment's "dispatch never passes `keyCapMicroUsd`" is false.
     But the arm stays **unreachable**: the B1 defence-in-depth block above it refuses any
     `deps.capMicroUsd` that is not a positive integer ≤ `MAX_SAFE_INTEGER`, `admitIssue` re-validates,
     and admission requires `remaining > 0`, so the clamp is a min of two positive safe integers.
     Verified by enumeration — `assertWithinBudget` has exactly one production call site.
     **No compensating release is owed.**
     **The code comment was NOT edited, deliberately.** `oci/exedev/Dockerfile` does
     `COPY src/fleet/ src/fleet/`, so `src/fleet/dispatch.ts` is a tracked buildId input: a
     *comment-only* edit there changes the image's file-input digest and demands DF2.10's
     re-publish → adopt → re-pin ritual. `tests/scripts/build-exedev-image.test.ts` caught it
     immediately and correctly. A one-line comment correction is not worth an image re-publish and
     incurring that obligation unasked would be scope creep, so the correction is recorded **here**
     and is owed as a one-line code follow-up by **the next story that already modifies
     `src/fleet/`** — DF3.7 and DF3.8 both do. (Same reason the `check:stories` npm alias was
     dropped: `package.json` is also a COPY input. `bun scripts/check-story-consistency.ts` and the
     test gate cover it with no image impact.)
  3. **The run-lock off-by-one — the handoff named the wrong stories.** It flagged "DF3.8 `:79` and
     DF3.7 `:128`". Ground truth (read with Python; `grep` is blind on that file, see below): the
     reentrancy guard is at **`:951`**, and `:952` is `reapStaleTemps`. **DF3.7 and DF2.11 cite `:951`
     correctly.** The wrong ones are **DF3.8 and DF6.1b**, both `:952`. Fixed by symbol. The
     handoff's own "`:128`" pointer landed on INV-IBOX-14, which carries no run-lock citation — a
     stale line pointer inside the brief warning about stale line pointers.
  4. **DF2.13 added to the epics index** with its full section.
  5. **`sprint-status.yaml` meta block corrected** to 42 stories / 169 pts, twelve not-done / 44.
     Two independent recomputations (parent + verifier E) agree.
  6. **The CI consistency check is BUILT, not proposed** — see below.
- **2026-09-08 — The `credentials.ts` citation drift, fully characterised and fixed.** Commit
  `287c036c` (this branch) inserted a **net +26** hunk (`+27/−1`) and produced *two* wrong populations:
  citations never updated (**+26** — DF5.3, DF5.4, DF5.5) and citations updated from the author's
  eyeballed *"the **twenty** lines it added"* estimate (**+6** — DF2.13's five, and the docstring
  itself, which puts `mintRunKey`'s cap resolution at `:281` when it is at `:287`). The docstring
  exists solely to warn about stale line citations and says *"this docstring managed to commit one
  about itself"* — then commits a second one in the same sentence. **All fixed by dropping the line
  numbers**, not by correcting them: correcting is what generated the second population.
  *The parent made this error too* — it reported DF2.13's citations as "correct, written post-commit",
  inferring from the commit's authorship instead of opening the file. Verifier E caught it. That is
  the sixth instance of the campaign's signature failure and the fifth time a subagent overruled a
  parent and was right.
- **2026-09-08 — `scripts/check-story-consistency.ts` SHIPPED (follow-up 6, built rather than
  deferred).** The handoff queued a CI consistency check for "once convergence is established".
  That is backwards — it is what *produces* convergence, so it was built now. Five machine-decidable
  checks: slate arithmetic (every stated total must equal the summed rows), story header vs yaml row
  (points, status), epics-index membership, dependency edges resolving to real story ids, and
  citations (past-EOF, and **ambiguous bare basenames**). Gated by `tests/scripts/story-consistency.test.ts`
  under plain `bun test`; run directly with `bun scripts/check-story-consistency.ts`. Deliberately
  **no npm alias** — `package.json` is a Dockerfile COPY input, so a script line would change the
  image buildId for a docs linter.
  **Scope, and why it is not a dodge:** it FAILS for not-yet-done stories and reports done ones as
  info. A done story's citations describe shipped history; a ready-for-dev story's are instructions a
  developer will follow. Nothing is grandfathered permanently — a story returning to ready-for-dev
  pulls its citations into the gate automatically.
  **It found 49 gated citation defects on first run**, all ambiguous basenames, now fixed: 27
  `run-record.ts` (`scripts/` 224 lines vs `src/providers/` 2,496), 6 `p1-19-…md` (live vs
  `_archived/v4-paperclip-era/` — and DF5.5 is the *repoint chore*), 6 `driver.ts`, 4 `runner.ts`,
  3 `report.ts` (**`src/reverify/report.ts` vs `src/phase-engine/gates/report.ts` — the two sides of
  R9's two-layer doctrine**), plus `schema.ts` and `manifest.ts`. Each resolved against an exact
  symbol hit (`provisionAdmittedRun` → `src/providers/driver.ts`; `appendReport` →
  `src/reverify/report.ts`; the roster `writes` field → `src/phase-engine/roster/schema.ts`).
  Now green: **42 stories, 169 pts, all gated artifacts agree.**
- **2026-09-08 — Full suite run; a campaign-introduced regression found and fixed.** `bun test`:
  **5,473 pass / 8 skip / 3 fail**. Each failure was bisected against a clean tree rather than
  assumed:
  1. **`buildIdFileInputs` — mine, and correct to fire.** Caused by the `dispatch.ts` comment edit
     and the `package.json` alias, both Dockerfile COPY inputs. Both reverted; the test file is now
     229 pass / 0 fail. See queue item 2 above.
  2. **`install-gitnexus-embeddings.test.ts` — a regression this campaign introduced and nobody
     noticed.** It **passes on `dev`** and fails at branch HEAD, so commit `8ac94bd8`
     ("gitnexus arch guard read the process arch, not the machine's") broke it. The guard now
     consults `sysctl -n hw.optional.arm64` alongside `uname -m`, but the test only ever shimmed
     `uname` — so on Apple Silicon it read the *real* machine fact, correctly kept `--embeddings`,
     and failed an assertion written for the pre-fix behaviour. **A stub that controls half a
     guard's inputs is not a stub**, and it cannot fail on the half it omits — which is precisely
     why the original Rosetta defect survived: the matrix pinned three (kernel, process-arch) pairs
     and the machine-arch fact was not an input at all. Fixed by shimming `sysctl` (env-driven
     `SYSCTL_ARM64`) and adding the missing case, *"Darwin x86_64 under ROSETTA on Apple Silicon
     KEEPS `--embeddings`"*. **Self-proved:** with the pre-fix guard temporarily restored, the new
     case fails and the other five pass; with the shipped guard, 6 pass / 0 fail. `tests/scripts/`
     is now 556 pass / 2 skip / 0 fail.
  3. **`tests/gitnexus/contract.test.ts` — pre-existing, NOT adopted here.** It fails on `dev` too.
     Installed CLI 1.6.9 **equals** the pin, so by the alarm's own triage this is *index-content*
     drift, not a version bump — almost certainly from this campaign's first-ever `--embeddings`
     reindex, which the `8ac94bd8` guard fix enabled. Drifted fields: `definitions[].id` no longer
     `File:`-prefixed, plus new `type` / `startLine` / `endLine` keys, and `process_symbols[].type`.
     **Left red deliberately.** `CLAUDE.md`'s upgrade ritual requires confirming intent against
     upstream before editing the strict schemas — and step 3 says to file upstream if a drop looks
     unintentional. That is a judgement call with an external-facing step, not a silent absorption.
     **This is the one remaining red in the suite and it does not block DF2.11/2.12/2.13.**
- **2026-09-08 — SEALED Wave-5 calibration retired as stale.** Both withheld items had **already been
  found and closed by Wave 5** (`8f69a8ef`): `commentsDigest` is now defined **pre**-redaction with the
  reproducibility argument written out (Wave 5 overruled the author's original call), and DF6.1a AC1's
  locality control now has a real proof mechanism (marker read through `readBoxFile`, `systemctl
  ExecMainStartTimestamp`, host process-table diff for `pi ` argv). The outgoing session carried the
  seal forward without re-opening the story. Wave 6 therefore had no calibration test from it.
- **2026-09-08 — OPERATOR RATIFICATIONS (three).** All four code follow-ups were verified against
  source by the parent before being put to the operator, not relayed on an agent's say-so:
  1. **Both ADR amendments ACCEPTED**, written as Appendix A + Appendix B with pointers at the
     original clauses. Appendix B was strengthened beyond the reviewer's proposal — enforcement
     rather than enumeration, and stated as a general invariant rather than a tier-3 footnote.
  2. **RSS bound is cgroup-enforced (`MemoryMax=`), not `ps`-sampled** — overriding the scan's own
     reuse recommendation and deliberately re-opening DF5.1's accepted ceiling rather than
     inheriting it. `fix-C-resident-bounds` was **redirected mid-flight**, before it could write the
     superseded mechanism. Its B1 pid-seam answer changes with it: the requirement becomes "place
     the resident in its own cgroup and read that cgroup's accounting" rather than "expose a pid
     through `ResidentSpawn` so the engine can sample it" — likely a smaller, cleaner seam.
  3. **Code follow-ups land as planned stories** — DF2.11 (F1+F3) and DF2.12 (F4) authored in
     parallel by a dedicated agent; F2 folded into DF6.1a as a design decision. `fix-A` and `fix-D`
     were messaged mid-flight with the consequences (delete the A1 deviation entries rather than
     reword them; digest-and-comment-IDs instead of raw text for B4, plus the general
     validate-before-the-irreversible-action invariant).
