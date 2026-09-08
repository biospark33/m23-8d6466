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
| Wave 6 | THIRD independent verification (convergence test) | ⬜ TODO |

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
