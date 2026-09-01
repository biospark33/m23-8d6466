# R5 — Dependency + Wrap-up Surface Analysis (DF1.10)

**Run:** qds-sprint-planning / df1-10-a · **Date:** 2026-08-31 · **Branch read from:** dev
**Subject:** DF1.10 "In-Box Steering Executor + Channel Lifecycle" — closes #181 (in-box ack round trip) + #180 (steering channel re-provision after tmpfs wipe)

---

## 0. Ground truth verified this session

| Fact | Verified via | Result |
|---|---|---|
| DF3.4 merged? | `gh pr view 150 --json state,mergedAt,baseRefName` | **MERGED 2026-08-31T19:41:26Z into `dev`** (head `feature/df3-4-approval-gate-attach-steering`). Merge commit at HEAD: `185291e Merge pull request #150 …` |
| sprint-status.yaml DF3.4 status | yaml:144 | **STALE — still `status: review`.** Same drift shape the 2026-08-26 artifact audit caught twice (DF3.1, DF3.2). Must be corrected to `done` in the wrap-up. |
| Issues #180 / #181 | `gh issue view` | Both **OPEN**. #181 = AC6 in-box ack round trip (Deviation 12); #180 = tmpfs `/run` wipe kills the steering channel, no re-provision. #181's body explicitly assigns the closing shape to "DF1.10 (in-box consumer)" and names the shape: resident consumes `/run/steering/inbox.ndjson`, writes `/run/steering/acks.ndjson`; engine leg reads/writes through the transport; live test pins attach → fold → ack. |
| DF slate tallies | yaml:32-38 + hand count | Header says 31 stories / 123 pts, tally "23/31, 93/123 pts". Hand count of `status: done` lines = **25 stories / 103 pts** (the tally predates DF3.3's 4 pts and DF3.4's 6 pts). |

---

## 1. Dependency graph

DF1.10 sits at the junction of the DF3 steering band and the DF1 engine. It is a **seam closer**, not an unblocker: nothing downstream depends on it, and it consumes contracts that already exist.

### Included deps (4)

| Dep | Status | Why it is a hard edge |
|---|---|---|
| **DF3.4** | **done** (PR #150 merged 2026-08-31 — see §0; the yaml line lies) | Owns `src/fleet/attach.ts` — the verb that writes the box's `/run/steering/inbox.ndjson` and the messageId/dedupe + ack contract the executor must honour. #181 is Deviation 12 of DF3.4. Without the shipped inbox file shape there is nothing to consume. |
| **DF3.3** | done (PR #135) | Owns `src/phase-engine/steering.ts` — the engine-owned solicitation port and the `.strict()` directive union. The in-box executor is the **on-box counterpart of that port**; DF3.3 also owns `src/fleet/resident.ts`, the process that will run the executor, and the journal `resident` block the new telemetry lands in. |
| **DF2.2** | done (PR #114) | Owns `src/providers/exedev/driver.ts`, the file #180's re-provision lands in (`create()` → `sudo install -d /run/steering` is the provisioning being made idempotent-and-repeatable) and the `exec` transport the send-failed path rides. Repo convention is to list the owner of a file you modify, not just the minimal cut (DF3.4 lists DF2.1/DF2.3/DF2.5; DF3.6 lists DF2.3/DF2.8). |
| **DF3.1** | done (PR #123/#134) | Owns the fleet verb surface the transport and the ack-provenance status join hang off; #181's follow-up "cross-process ack-provenance surfacing on the attach CLI" is a `fleet status`/attach join, i.e. DF3.1's surface. |

### Excluded candidates, with the argument

- **DF1.1** (engine lifecycle primitive) — **exclude.** DF1.10 does not extend DF1.1's primitive; it extends **DF3.3's** steering seam and rewires the leg at `scripts/pipeline-run.ts`. Precedent is exact: DF3.4 touches the same engine-adjacent seam and omits DF1.1 from its deps, while DF3.3 (which authors the port) lists it. DF1.1 arrives transitively via DF3.3.
- **DF2.1** (provider-driver interface / run records) — **exclude, and record a keep-out.** DF2.1's run record is **closed**; DF3.3's own AC pins "zero fields added to DF2.1's closed run record". DF1.10's telemetry (re-provision count, ack-provenance) belongs in the DF3.3-owned journal `resident`/steering block. Making DF2.1 a dep would invite widening the one schema the fleet band has kept shut.
- **DF3.6** (resident bounds) — **KEEP OUT, argued below.**

### DF3.6 keep-out argument (include vs keep-out)

**Keep out.** Three reasons, each one independently sufficient:

1. **No data dependency.** DF3.6 is `ready-for-dev`, not done — listing it would block a seam closer on unbuilt work that shares no input with it. DF1.10 consumes DF3.4's inbox file and DF3.3's port; it neither sets nor reads bounds.
2. **The split rationale is already on record.** The original derivation split DF3.3/DF3.6 precisely because the bounds are "a different component, a different test surface, and separately verifiable" (`_bmad-output/workflow-state/qds-sprint-planning/df-v5/research/R5-dependency-sizing.md` §splits). DF3.6's surface is the **phase-engine watchdog** (iterations / RSS / absolute µ$ ceiling) enforced host-side; DF1.10's is an **on-box consumer + channel provisioning**. Re-fusing them is the exact mistake the split was taken to avoid.
3. **DF3.6's story file already fixes the ownership boundary on the shared file.** `df3-6` §Files-to-Modify notes the three-way shared `src/phase-engine/steering.ts`: "DF3.3 authors the port and its three solicitation points, **DF3.4 adds the attach inbox drain + ack append at those same points**". DF1.10 replaces that drain with the on-box consumer — it lands at DF3.4's existing attachment points, not at DF3.6's.

**Boundary note, not a dep:** DF1.10's new telemetry must ride the DF3.3 journal block (integer µ$, counts, no ratio fields — the R5 §6 fact-12 rule DF3.6 enforces), so DF3.6 can consume on-box re-provision/iteration counts later without a schema change. Say it in the story's Technical Notes; do not create an edge. If DF3.6 happens to land first, the only interaction is that the resident the executor runs inside is now bounded — additive, non-blocking.

### Transitive closure (what the 4 edges buy)

`DF2.2 → DF3.1 → DF3.3 → DF3.4` is the exact chain the original sizing called the critical path (`DF2.1 → DF2.3 → DF2.2 → DF2.5 → DF3.1 → DF3.3 → DF3.4`), all four now merged. **DF1.10 is therefore startable immediately — it has zero open predecessors.** That is the single strongest argument for the sprint tag below.

---

## 2. Sprint tag → **v5-S2, marked as a late/unslotted addition**

Where the in-box executor sits in the design's build order: §8 step 1 is the TS phase engine (DF1) and §8 step 3 is the fleet dispatcher (dispatch, fan-out, status, **attach**, harvest, teardown). DF1.10 is numbered DF1 (the derivation rule is `DF{step}.{n}` and the issue trail named it DF1.10) but its substance is the **step-3 attach loop's missing on-box half** — it exists because step 3 shipped the write side of the steering channel without a consumer.

Evidence for the tag:

- **Its dependency band is S2.** All four deps are v5-S2 stories; DF3.3/DF3.4/DF3.1/DF2.2 are the S2 fleet-steering band. Precedent for a DF1-numbered story tagged outside S1 exists: **DF1.8 is v5-S2**.
- **Precedent for late additions is exactly this form.** DF6.2's Sprint line reads: `v5-S3 (unslotted fix; surfaced by PR #135 review round 5, fix-tests-b report "found-but-not-fixed" #1)`. DF1.10 surfaced in **PR #150 round 10** (S2 fleet band), so the parallel form is `v5-S2 (late addition — unslotted; surfaced by PR #150 review round 10 / #180 + #181)`.
- **Sequencing, not load-balancing, drives it.** The seam is live *now*: until it closes, every live fleet e2e round must honestly assert `attach-not-acked`/`no-ack` as the PASS shape (#181's own words), i.e. the fleet band's observable contract is degraded. It has zero open predecessors, so it should start immediately — that is an S2 position by definition, regardless of which band the calendar is in.

**The honest counter-argument, recorded so the writer can't miss it:** S3 is much lighter. S1=48 / S2=50 / S3=25 pts against a ~45-50 pt per-4-week baseline, so S3 has ~20-25 pts of headroom and S2 (at 55 with this story) would sit over it. If the operator weighs band capacity over band coherence, flip the tag to `v5-S3` — **no dependency edge moves either way**, which is why this is a cheap decision to revisit. Recommendation stands at v5-S2 because the degrade is being paid every day the seam stays open, and S2's remaining load is in practice only DF3.5 + DF3.6 (5 pts).

**No S3-tagged story constraint applies either way:** S3-tagged stories already exist (`grep '# v5-S3'` → DF4.1, DF4.2, DF5.3, DF5.4, DF5.5, DF6.1 — 6 stories / 25 pts). There is no "first S3 story" ceremony to perform.

Story-file Sprint header, proposed:

```
**Sprint:** v5-S2 (late addition — unslotted; surfaced by PR #150 review round 10 / #180 + #181; fleet steering band)
```

---

## 3. Points estimate → **5 SP**

Siblings, for calibration (all same band, same module family):

| Story | SP | Surface |
|---|---|---|
| DF3.4 | 6 | approval gate + attach verb + 3 CLI verbs + status join + DF2.1 contract widening + approver security surface |
| DF3.3 | 4 | resident spawn + engine steering port (3-point closed union) + pipeline-run wiring + e2e |
| DF3.6 | 3 | engine-side bounds (one component, one test surface) |
| **DF1.10** | **5** | on-box executor + channel lifecycle + engine rewiring + live e2e |

**Why not 4:** 4 undersells it because the scope is **three disjoint file clusters, not one** — (a) the on-box executor that drains `/run/steering/inbox.ndjson` and writes `acks.ndjson` (fleet/resident side), (b) #180's re-provision lifecycle in the exe.dev driver (`idempotent install -d` + verify chain + re-provision count in telemetry, keyed on first `send-failed` per box, so a reboot loop is *visible*), and (c) the engine-leg rewiring at `scripts/pipeline-run.ts` that swaps `localSteeringInbox` for the attach transport. Add the MANDATORY live e2e that pins the full attach → fold → ack round trip on a real box — the exact demo DF3.4 could not run (#181: FakeDriver is AC6-forbidden as sole evidence, and the live shape is what exposed DF3.4's AC7 defect). DF3.3 got 4 for two clusters + e2e.

**Why not 6:** 6 is DF3.4's price, and DF3.4's premium came from surface DF1.10 does not have: a new operator-facing security surface (approver allowlist with directory-mode/ownership guards), three new CLI verbs, a status join, and a DF2.1 schema widening whose secret-scan recursion had to be rebuilt. DF1.10 adds **no new contract type** — it implements the consumer side of a contract that already exists and adds no field to any closed record. No new authz surface, no schema migration.

**Gate check:** 5 ≤ 8 (atomicity SP budget). DOD should stay ≤10 items and the normative body ≤200 lines — the three clusters fit comfortably if the driver re-provision is specced as one idempotent script + one call site rather than a per-driver generalization.

---

## 4. Wrap-up surface (this repo — the DF track has NO `_bmad-output/epics.md`)

The skill's canonical Phase 3 list (`.claude/skills/qds-sprint-planning/steps/phase-3-wrap-up.md` §3.3, items 1-8) assumes `_bmad-output/epics.md` exists. **It does not** (`ls _bmad-output/epics.md` → absent) and `meta.index` (`implementation-artifacts/epics-and-stories-v4.md`) contains **zero** DF mentions. The DF backlog's only index is the sprint-status.yaml comment block at lines 97-105 plus the story files themselves. The two spec docs are **closed records by their own rule** ("the three documents above are closed records and are not modified" — derivation decisions doc header), and **neither indexes stories individually** in a way DF1.10 would have to join: the derivation decisions doc has no per-story enumeration section (only decision rows DD-n + coverage-hole rows), and the disposition audit is a 30-row phase-0/1 table with **zero** `DF1.*` references. **Neither doc needs a DF1.10 entry.** Provenance belongs in the story file's own Sprint line — that is the DF6.2 precedent, and it is the right one.

### The exact wrap-up file list

| # | File | Action |
|---|---|---|
| 1 | `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-steering-executor.md` | **Create** (Phase 2 output; 13-heading template, `**Story Points:** 5` / `**Sprint:** v5-S2 (late addition …)`; spec refs = design §5.1 tier 1/2, §5.2, §8 steps 1+3, D4; issues #180/#181 as the closing shape; DF3.4 Deviation 12 as ancestry) |
| 2 | `_bmad-output/sprint-artifacts/sprint-status.yaml` | **Five edits** (see §6): (a) new DF1.10 story line under `df1.stories`; (b) `df1.points: 32 → 37`; (c) header comment block lines 32-38: "DF totals: 32 stories / 128 points (DF1 **9**/37, DF2 9/34, DF3 6/24, DF4 2/10, DF5 5/17, DF6 1/6)" and per-sprint "S1=48/S2=**55**/S3=25 -> **128** (S1=12/S2=**14**/S3=6 stories)"; (d) line 103 `# Atomicity:` pointer gains the new audit path; (e) header note replaced (next row) |
| 3 | `_bmad-output/sprint-artifacts/sprint-status-history.md` | **Drain + append.** Move the current "2026-08-29 tech-debt wave 0" note out of the yaml header into a `## 2026-08-29` section (the header's own rule: "Append new notes here; drain them there"), and add a dated entry for this planning run |
| 4 | `_bmad-output/sprint-artifacts/dark-factory-v5/atomicity-audit-2026-08-31.md` | **Create** — single-story audit replicating the 2026-08-20 header format (Auditor: qds-sprint-planning Phase 2.5; Total stories audited: 1 (DF1.10); Pass/Warn/Block; Context; the same 8-check table: normative size ≤200 / total ≤400 / SP ≤8 / DOD ≤10 / title AND-connectors / blocker markers / Files-to-Modify present / Security Invariants triggered+substantive) |
| 5 | `docs/superpowers/specs/2026-08-11-v5-story-derivation-decisions.md`, `…story-disposition-audit.md`, `…dark-factory-v5-architecture-design.md` | **No edit.** Closed records; no per-story index to maintain. (If the operator wants a decision row, the established pattern is a dated *appendix* like the existing "Appendix (2026-08-25): deferred-seam register" — optional, not required.) |
| 6 | `/Users/steve/QDS-Factory/CLAUDE.md` | **No edit.** The skill's "CLAUDE.md current-status line updated" step is a no-op here: the repo CLAUDE.md carries **no sprint/status line**. Its only DF-relevant lines are the `qds-dev branch convention: prefix=feature/ base=dev target=dev` note (already correct, already dated 2026-08-28) and the `qds-live-e2e` skill pointer (unchanged). Nothing to update. |
| 7 | Git | **Branch + PR** (§5), plus `detect_changes()` per repo CLAUDE.md before commit |

### Two pre-existing drifts the same wrap-up PR should absorb (one-line yaml edits each)

1. **DF3.4 line is stale at `review`** while PR #150 merged into dev on 2026-08-31 → set `status: done` and append the merge note. This is the third instance of the exact drift the 2026-08-26 audit documented on DF3.1 and DF3.2; leaving it would repeat the audit's own lesson.
2. **DF6.2 has a story file and a merged PR but no yaml line at all.** `stories/df6-2-dispatch-refusal-verdict-integrity.md` exists (2 SP, v5-S3, implemented by PR #136, commit `bed4b57`, merged `decd385`) and `grep DF6.2` over the yaml + history finds nothing, while the header still says "DF6 1/6". If absorbed, totals become 33 stories / 130 pts (DF6 2/8, S3=27). **Flag for the operator** — it changes every number in the §6 tally block, so it is a decision, not a mechanical fix. The totals I propose in §6 assume it is NOT absorbed (32/128); if it is absorbed, add +1 story / +2 pts everywhere and add the DF6.2 line.

---

## 5. Branch / PR convention

Confirmed from repo CLAUDE.md (unchanged, current): **prefix `feature/`, base `dev`, target `dev`** — "`dev` is the integration base — ALL feature/fix PRs merge into `dev`; `dev` → `main` is a periodic promote/sync PR only." Verified in practice by PR #150 (`baseRefName: dev`, head `feature/df3-4-…`) and the tech-debt waves #147-#155, all `baseRefName: dev`.

- **Branch:** `feature/df1-10-in-box-steering-executor` (matches the `feature/df{step}-{n}-{kebab}` pattern: `feature/df3-4-approval-gate-attach-steering`, `feature/df3-3-resident-orchestrator-agent`, `feature/df3-2-fanout-best-of-n`).
- **PR title (story-authoring PR):** `DF1.10: in-box steering executor + channel lifecycle (story spec)` — the repo's PR titles for DF work are plain `DF{n.n}: <lowercase summary>` (PR #150: `DF3.4: tier-1 pre-PR approval gate + attach steering`), not conventional-commit subjects.
- **Commit message form:** conventional commits with the story id lowercased-and-hyphenated as the scope, per `fix(df3-4):`, `docs(df3-4):`, `test(e2e):`, `fix(df6-2):`. For the planning PR: **`feat(df1-10): write the in-box steering executor + channel lifecycle story spec`** (repo precedent for story-writing commits: `feat(sprint): author QDS-Factory v4 Phase 0+1 stories`, `feat(epic-qds-mem-003): write 13 enterprise-grade Phase-2 … stories`). For the later implementation commits: `feat(df1-10): …` / `fix(df1-10): …`.
- **Issue wiring:** reference #180/#181 in the story Spec Reference and the PR body. Do **not** put `Closes #181` on the spec PR — the issues close when the executor ships, not when the spec lands. `Fixes #181, fixes #180` belongs on the implementation PR.

---

## 6. Exact sprint-status.yaml story line (proposed)

Title in the yaml carries no backticks (repo convention); the story file heading uses them around code words, as DF3.4 does (`# DF3.4: Tier-1 Pre-PR Approval Gate + `attach` Steering` vs yaml `"Tier-1 Pre-PR Approval Gate + attach Steering"`). The handoff title is preserved verbatim.

```yaml
      DF1.10: { title: "In-Box Steering Executor + Channel Lifecycle", points: 5, status: ready-for-dev, deps: [DF2.2, DF3.1, DF3.3, DF3.4] }  # v5-S2 — late addition (unslotted), closes the DF3.4 round-10 seams: #181 (in-box ack round trip — fleet attach writes the BOX's /run/steering/inbox.ndjson while the engine leg drains a HOST-local file, so attach-acked is unreachable on real substrate) + #180 (the channel lives on tmpfs /run and a VM reboot silently wipes it, regressing the resident to attach send-failed for life). Ships the on-box consumer of DF3.3's solicitation port (drain inbox.ndjson -> write acks.ndjson, DF3.4's messageId dedupe honoured), rewires the engine steering leg to read/write through the attach transport instead of a host-local file, and adds attach-time re-provision (idempotent install -d + verify chain on first send-failed per box, re-provision count in telemetry so a reboot loop is visible). Telemetry rides the DF3.3 journal resident block — no field added to DF2.1's closed run record. MANDATORY live e2e pins the full attach -> fold -> ack loop on a real box (FakeDriver is AC6-forbidden as sole evidence). Deviation 12 of DF3.4 is the ancestry; DF3.6 stays OUT of deps (bounds are the engine watchdog, a different component and test surface — telemetry is the only shared contract).
```

Accompanying header edits (exact numbers, assuming DF6.2 is NOT absorbed):

```yaml
    points: 37          # df1 block, was 32
```
```yaml
  # Dark Factory v5 totals: 32 stories / 128 points (DF1 9/37, DF2 9/34, DF3 6/24,
  # DF4 2/10, DF5 5/17, DF6 1/6). Per-sprint-tag subtotals S1=48/S2=55/S3=25 -> 128
  # (S1=12/S2=14/S3=6 stories). 25/32 done / 103/128 pts as of 2026-08-31 (DF3.4 PR #150).
```
And the header note above it is replaced by the new "Most recent note" (this planning run + the DF3.4 merge + the tally correction 23/93 → 25/103), with the displaced note drained to `sprint-status-history.md`.

Story-file heading + header block:

```markdown
# DF1.10: In-Box Steering Executor + Channel Lifecycle

**Story Points:** 5
**Sprint:** v5-S2 (late addition — unslotted; surfaced by PR #150 review round 10 / #180 + #181; fleet steering band)
```

---

## 7. One-paragraph summary for the writer

DF1.10 deps `[DF2.2, DF3.1, DF3.3, DF3.4]` — all merged, so the story starts immediately; DF1.1 and DF2.1 are excluded (the engine touch is at DF3.3's port, not DF1.1's primitive, and DF2.1's run record stays closed), and DF3.6 is deliberately kept out (different component and test surface, no data dependency; a boundary note on telemetry, not an edge). Tag `v5-S2` as a late/unslotted addition, matching the DF6.2 form and the DF1.8 precedent of a DF1 story outside S1, with the S3-capacity alternative recorded as a cheap flip. **5 SP** — three disjoint file clusters plus a mandatory live round trip puts it above DF3.3's 4, and the absence of any new contract or authz surface keeps it below DF3.4's 6. The wrap-up surface is seven items: the story file, five edits to sprint-status.yaml, a history-file drain+append, a new single-story atomicity audit in the 2026-08-20 format, no spec-doc entries (closed records, no per-story index), no CLAUDE.md edit (no status line exists), and the branch/PR per §5 — plus two pre-existing yaml drifts (DF3.4 `review`→`done`; DF6.2 missing line) surfaced for the operator to absorb.
