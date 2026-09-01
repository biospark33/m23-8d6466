# R10 — Dependency Sanity, Sprint Math + Wrap-up Surface (4-story in-box restoration arc)

**Run:** qds-sprint-planning / df-inbox-arc-a · **Date:** 2026-08-31 · **Branch read from:** `feature/df1-10-tier2-placement-adr`
**Subject:** DF2.10 · DF1.10 · DF1.11 · DF3.7 + the DF3.6 re-sequence chore
**Supersedes (in form only):** `…/df1-10-a/research/R5-dependency-wrapup.md` — written for the rescinded 1-story option. Its FORM is reused; every number here is recomputed.

---

## 0. Ground truth verified this session

| Fact | Verified via | Result |
|---|---|---|
| ADR content | read `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` | ACCEPTED. Consequences list is **five** items: (1) image ownership, (2) DF1.10 re-chartered = in-box engine + steering executor + channel lifecycle, (3) **supervision (systemd unit + restart policy + reclaim)**, (4) approval-gate bridge, (5) DF3.6 re-sequence. |
| PR #182 | `gh pr view 182` | **OPEN**, base `dev`, head `feature/df1-10-tier2-placement-adr`. Docs+evidence only, no code. The ADR file exists **only on this branch**. |
| PR #150 (DF3.4) | `gh pr view 150` | **MERGED 2026-08-31T19:41:26Z into `dev`.** Merge commit `185291e` is at HEAD. |
| DF3.4 yaml line | yaml:144 | **STALE — still `status: review`.** Confirmed drift. |
| DF6.2 yaml line | `grep -rn "DF6.2\|df6-2"` over yaml **and** history file | **NONE.** Zero hits in both. Story file exists (`df6-2-dispatch-refusal-verdict-integrity.md`, 2 SP, `**Sprint:** v5-S3`). |
| DF6.2 merge | `gh pr view 136` | **MERGED 2026-08-28T12:48:05Z into `dev`**, merge commit `decd385`, title `fix(df6-2): dispatch_task refusals and classified failures settle the phase fail`. Branch commit `bed4b57`. Claim **CONFIRMED**: a merged story with no yaml line. |
| Header tally | yaml:15 vs hand count of `status: done` | Header says **23/31, 93/123**. Real count today = **24 done / 97 pts** (DF3.4 still `review`); **25 / 103** once DF3.4 is corrected. Header is two corrections behind. |
| Epic points | hand-summed each block | df1 **32** (8 stories) ✓, df2 **34** (9) ✓, df3 **24** (6) ✓, df4 10 (2), df5 17 (5), df6 6 (1). Totals reconcile to 31 / 123 exactly as the meta block claims. |
| Sprint-tag subtotals | `# v5-S*` comment scan | S1 = 12 stories / 48 pts ✓; S2 = 13 / 50 ✓; S3 = 6 / 25 ✓. All three verified, not taken on trust. |
| DF1.10 collision in the yaml | `grep DF1.10` yaml | **No line exists.** DF1 numbering also skips DF1.7 (never derived) — DF1.10/DF1.11 append cleanly after DF1.9. |
| Story filename convention | `ls …/dark-factory-v5/stories/` (32 files) | `df{epic}-{n}-{kebab}.md`, lowercase, no zero-pad, no epic-2-digit padding. All four proposed slugs conform. |
| Atomicity audit format | read `atomicity-audit-2026-08-20.md` | Header = Auditor / Total stories audited / Pass-Warn-Block / Context; then per-story 8-row check table. Reusable verbatim. |
| History file convention | read header of `sprint-status-history.md` | "Superseded header notes drained from sprint-status.yaml… oldest first", `## YYYY-MM-DD` sections, entry text **verbatim**, tallies explicitly marked superseded. |

---

## 1. Dependency sanity check — the slate, audited edge by edge

Verdict up front: **the four dep arrays are sound and I recommend keeping all of them.** I propose **three additions** and surface **one gap in the arc itself** that is more important than any edge.

### DF2.10 — Factory-Owned Boot Image · 5 pts · deps `[DF2.2, DF2.9]`

| Edge | Verdict | Evidence |
|---|---|---|
| DF2.2 (done) | **KEEP — hard** | Owns `src/providers/exedev/driver.ts`. The ADR names the exact call site: "The driver simply never passes them (`driver.ts:249-255`)". Threading `--image` / `--setup-script` / `--registry-auth` through `create()` modifies a DF2.2-owned file. |
| DF2.9 (done) | **KEEP — hard** | Owns the OCI image contract, `oci/Dockerfile`, `license-sweep.ts` and `generate-notice.ts`. Forking exeuntu and publishing a factory image must keep the NOTICE sweep green — the vendored-tree obligation DF4.1's line already records. |
| DF2.3 | **exclude, cite instead** | A registry pull credential is a different credential class from DF2.3's per-run OpenRouter mint/cap/revoke lifecycle. No edge. The story should instead cite DF2.1's `assertNoSecret` and DF2.2's setup-gate 0600 env-file convention so the registry secret is handled to the same standard. |
| DF1.6 | **exclude** | The ADR notes image ownership "makes `buildTeamSpawn`'s `file:"bun"` correct in-box" — that is a *consequence* DF2.10 delivers, not an input it consumes. |

### DF1.10 — In-Box Phase Engine · 8 pts · deps `[DF1.6, DF2.5, DF2.10, DF3.1]`

| Edge | Verdict | Evidence |
|---|---|---|
| DF1.6 (done) | **KEEP — hard** | The 8-pt flagship that owns `dispatch-task.ts` + `team-lead-driver.ts` — the phase being relocated. |
| DF2.5 (done) | **KEEP — hard** | Bundle harvest + tested teardown. ADR consequence 2: "records/trace written in-box and harvested (§5.3)". |
| DF2.10 (new) | **KEEP — hard** | No bun, no pinned pi, no engine in-box. Strict predecessor. |
| DF3.1 (done) | **KEEP — hard** | Owns the fill path + `dispatch/status/harvest/teardown` verbs and AC9a manifest stamping into the box. |
| **DF1.1** (done) | **ADD — recommended, strong** | DF1.10 is now *literally* "the phase engine runs in-box" — DF1.1 owns `phase.ts` + the versioned manifest primitive and `scripts/pipeline-run.ts` is the leg being rewired. Every story that touches the engine lists DF1.1 (DF3.2, DF3.3, DF3.6 all do). R5's exclude-DF1.1 argument was correct for the *rescinded* steering-only story and does not survive the re-charter. |
| **DF1.4** (done) | **ADD — recommended, moderate** | ADR §5.3 harvest + the probe's measured `bun:sqlite` in-box mean the trace DB is opened on the box. DF1.4 owns the 7-table schema / WAL / rowid-cursor reads. Repo convention (list the owner of the file you modify) applies. If the writers determine the DB open site does not move, drop this edge and say so in Technical Notes. |
| DF2.2 | **exclude** | Transitive via DF2.10, which is where the `create()` changes now land. |
| DF3.3 | **exclude *conditionally* — see the open question below** | |

**Open question the writers must settle before AC1 is drafted:** *which story moves the resident?* The ADR's INV-RES-3 finding is about `src/fleet/resident.ts:446-471` spawning pi on the **host** with a **second** capped key. The slate splits engine (DF1.10) from steering executor (DF1.11). If DF1.10 relocates only the engine, INV-RES-3 stays violated across the whole arc and DF1.11 silently inherits a resident relocation on top of its steering scope — which would push DF1.11 past 5 pts. **Recommendation:** DF1.10 owns the resident relocation (it is the process the engine runs inside, and the one-secret-per-box restoration is an engine-placement property), and **DF3.3 is therefore added to DF1.10's deps**. If the operator prefers it in DF1.11, DF1.11's points need re-examining. Either way, one of the two stories must name it explicitly.

### DF1.11 — In-Box Steering Executor + Channel Lifecycle · 5 pts · deps `[DF1.10, DF3.3, DF3.4]`

All three **KEEP — hard**. DF1.10 supplies the in-box runtime; DF3.3 owns `src/phase-engine/steering.ts` (the solicitation port + `.strict()` directive union) and `src/fleet/resident.ts`; DF3.4 owns `src/fleet/attach.ts` and the messageId/dedupe/ack contract the executor must honour.

- **DF2.2 dropped correctly.** R5 listed DF2.2 because #180's fix was a driver-side reactive re-provision. The ADR replaces that with a declarative `/etc/tmpfiles.d/qds-steering.conf` shipped in the image — that surface is now **DF2.10's**, reached transitively through DF1.10. Optional-add only if the writers decide DF1.11 authors the tmpfiles unit directly; non-blocking either way.
- **DF3.1** — exclude; transitive via DF3.4 (which lists it) and DF1.10.

### DF3.7 — Approval-Gate Bridge · 4 pts · deps `[DF1.10, DF3.4]`

| Edge | Verdict | Evidence |
|---|---|---|
| DF1.10 | **KEEP — hard** | The in-box engine writes the awaiting marker the host polls. |
| DF3.4 (done) | **KEEP — hard** | Owns `approval-gate.ts` / `approvers.ts` and the `pausing → teardown → awaiting-approval` order the ADR pins as unchanged (`approval-gate.ts:8-17`). |
| **DF5.1** (done) | **ADD — recommended, moderate** | DF5.1 owns the `ApprovalPort` seam and `recordApprovalPort(store)` at `reverify/runner.ts:406`. DF3.4's round-6 note records that the **real teardown wiring is still owed as a follow-up** at exactly that call site — a bridge that changes how the marker is produced and polled lands in DF5.1's file. DF5.1 already depends on DF3.4, so the edge does not create a cycle. |
| DF2.5 | **exclude** | Transitive via DF3.4; the pause path's real teardown is DF3.4's composition. |

### DF3.6 re-sequence chore

Proposed new deps: `[DF1.1, DF1.5, DF1.10, DF2.3, DF2.8, DF3.3]` (adds DF1.10 to the existing five; ordered by epic, matching repo style).

**The re-validation is real work, not a comment.** DF3.6's spec already charters in-box in eight places, and each becomes *correct* rather than aspirational once DF1.10 lands — the writers must confirm each still reads right against the new placement:

- `:69` bounds enforced "at manifest load inside the box, before…"
- `:85`, `:90`, `:167-168`, `:254` — five separate assertions that "the host-side `.sandbox/runs/<id>.json` record does not exist inside the box"; the frozen-manifest-only rule these justify is unchanged, but the reasoning sentence should now cite the ADR rather than reading as a workaround
- `:108-109`, `:136`, `:202-203` — the platform-dispatched RSS sampler (`/proc/<pid>/status` on Linux in-box, `ps -o rss=` on darwin "the operator host, where DF3.3's e2e demo runs"). **The darwin branch's justification evaporates** once the resident runs in-box: it survives as a dev-host convenience, not as a correctness requirement. Say which.
- `:279` — the DoD grep asserting `src/phase-engine/` contains no read of `.sandbox/runs/` — still valid, now for the designed reason.

**Sprint-tag inversion (operator decision).** DF3.6 is tagged `v5-S2` and would now depend on an S3 story. Either accept the cross-band edge, or re-tag DF3.6 to `v5-S3`. §3 gives both sets of numbers. My recommendation: **re-tag to v5-S3** — a story that cannot start until an S3 predecessor merges is not an S2 story, and "re-sequence" is precisely what the ADR asked for.

### The gap in the arc — ADR consequence 3 has no story

The ADR lists five consequences. The slate covers 1 (DF2.10), 2 (DF1.10 + DF1.11), 4 (DF3.7) and 5 (the DF3.6 chore). **Consequence 3 — "Supervision — systemd unit + restart policy + reclaim" — is unassigned.** `grep -rln systemd` over the stories directory returns exactly one file, `df3-1-dispatcher-core-verbs.md`, and that is incidental.

This matters because the ADR's own re-opening criteria name it: "measured in-box resident/engine failure modes (e.g. pi stall regression) exceed what **the systemd restart policy** can mask" — the restart policy is load-bearing for the decision, so shipping the arc without it leaves the ADR's own risk acceptance unbacked.

**Recommendation (no new story):** fold it, and say which half owns which. The unit *file* and its `Restart=` policy ship in the image (**DF2.10**, +0 pts — it is a Dockerfile/unit line alongside the tmpfiles.d entry); the *reclaim* semantics — what a restarted engine does with a half-finished run — belong to **DF1.10** and are already inside its 8 pts. Surface this to the operator: if they want supervision separately verifiable, it is a 3-pt DF2.11 and the arc becomes 5 stories / 25 pts.

### The DF1.10 renumbering collision — a shipped string goes wrong

The rescinded plan had **DF1.10 = the in-box steering executor**. The new slate reassigns DF1.10 = In-Box Phase Engine and moves the executor to DF1.11. The old meaning is written into places that are not planning artifacts:

- `scripts/fleet.ts` `no-ack` remediation text, shipped to operators: *"no in-box executor exists yet (DF1.10)"*
- `tests/fleet/gate-verbs.test.ts:1393` — `expect(envelope.remediation).toContain("DF1.10")` **pins that string in a test**
- `df3-4-…md:448` HONEST LABEL, `:774` Deviation 12, `:784` and `:879` follow-ups; `pipeline-run-remote.ts:5-20`; issues #180/#181; `qds-dev/df3-4/state.yaml:177,627`

**Consequence:** DF1.11's implementation must update the remediation string **and** that test assertion, and the story should say so in Files-to-Modify. Both DF1.10 and DF1.11 should carry a one-line disambiguation in their Spec Reference: *"pre-2026-08-31 references to 'DF1.10 owns the round trip' (DF3.4 Deviation 12, #180/#181, the `fleet attach` no-ack remediation) mean **DF1.11** under the ADR's re-charter."* Cheap now, expensive as an archaeology exercise in three weeks.

---

## 2. Exact sprint-status.yaml edit drafts

### 2a. Four new story lines

Format matches the file: 6-space indent, single-line flow map, `# v5-S3 —` tag comment. Titles are title-case with no backticks (repo convention; backticks live in the story-file H1). Status is `ready-for-dev`, which is what the skill writes at wrap-up.

Insert after the `DF1.9:` line (yaml:119), inside `df1.stories`:

```yaml
      DF1.10: { title: "In-Box Phase Engine", points: 8, status: ready-for-dev, deps: [DF1.1, DF1.4, DF1.6, DF2.5, DF2.10, DF3.1, DF3.3] }  # v5-S3 — in-box restoration arc, story 2 of 4. Per ADR docs/superpowers/specs/2026-08-31-tier2-placement-adr.md (ACCEPTED 2026-08-31): the shipped host-side placement of tier 2 (DF3.3 resident via host Bun.spawn; engine via host scripts/pipeline-run.ts) is a silent unratified deviation from design D4/§5.1, and is unwound here. Relocates the deterministic TS phase engine AND the resident into the sandbox box (restoring §6.2 one-secret-per-box — the host-side resident mints a SECOND capped key, violating INV-RES-3 in substance); records + trace DB written in-box and harvested per §5.3; DF5.1 host re-verify unchanged, preserving R9's two-layer evidence doctrine. Also owns supervision RECLAIM semantics (ADR consequence 3; the systemd unit + Restart= policy itself ships in DF2.10's image). NOTE THE RENUMBERING: every pre-2026-08-31 reference to "DF1.10 owns the round trip" (DF3.4 Deviation 12, #180/#181, the fleet attach no-ack remediation string) means DF1.11 now.
      DF1.11: { title: "In-Box Steering Executor + Channel Lifecycle", points: 5, status: ready-for-dev, deps: [DF1.10, DF3.3, DF3.4] }  # v5-S3 — in-box restoration arc, story 3 of 4. Closes #181 in its literal on-box reading: the resident consumes /run/steering/inbox.ndjson and writes acks.ndjson ON THE BOX, honouring DF3.4's messageId dedupe; the live e2e PASS shape INVERTS from the honest `no-ack`/exit-6 shipped today to `attach-acked`. Closes #180 declaratively rather than reactively — the 2026-08-31 probe measured /run as tmpfs and a real reboot wiping /run/steering, and measured systemd as PID 1, so /etc/tmpfiles.d/qds-steering.conf recreates the channel at boot (no send-failed-triggered re-provision machinery). Telemetry still counts channel recreations so a reboot loop stays visible, riding DF3.3's journal resident block — no field added to DF2.1's closed run record. MUST update the operator-facing no-ack remediation in scripts/fleet.ts and its assertion at tests/fleet/gate-verbs.test.ts:1393, both of which name "DF1.10".
```

Insert after the `DF2.9:` line (yaml:134), inside `df2.stories`:

```yaml
      DF2.10: { title: "Factory-Owned Boot Image", points: 5, status: ready-for-dev, deps: [DF2.2, DF2.9] }  # v5-S3 — in-box restoration arc, story 1 of 4; strict predecessor of DF1.10. Per ADR 2026-08-31 consequence 1: fork the exeuntu Dockerfile with bun + a pinned pi + tooling, publish, pin BY DIGEST, and thread --image/--setup-script/--registry-auth through exedev create() — the 2026-08-31 probe measured all three flags available on our plan and the driver simply never passing them (driver.ts:249-255). Retires the pi 0.55.0/0.84.x drift and makes DF1.6's buildTeamSpawn file:"bun" correct in-box (bun is absent from the stock image but installs in seconds and persists). Ships the systemd unit + Restart= policy (ADR consequence 3 — measured: systemd is PID 1 and enabled units restart at boot) and the /etc/tmpfiles.d/qds-steering.conf DF1.11 relies on. Must keep DF2.9's NOTICE sweep green over the new vendored tree. A registry pull credential is NOT a DF2.3 per-run mint — handle it to DF2.1 assertNoSecret + DF2.2 setup-gate 0600 standards; no dep edge.
```

Insert after the `DF3.6:` line (yaml:146), inside `df3.stories`:

```yaml
      DF3.7: { title: "Approval-Gate Bridge", points: 4, status: ready-for-dev, deps: [DF1.10, DF3.4, DF5.1] }  # v5-S3 — in-box restoration arc, story 4 of 4. Per ADR 2026-08-31 consequence 4: the approval gate STAYS HOST-OWNED by construction (its state must outlive the box; approval-gate.ts:8-17 pausing -> teardown -> awaiting-approval is unchanged). The in-box engine writes an awaiting marker; the host polls it. DF5.1 is an edge because it owns the ApprovalPort seam and recordApprovalPort(store) at reverify/runner.ts:406 — the same call site DF3.4 round 6 recorded as still owing REAL teardown wiring; DF5.1 already depends on DF3.4, so this adds no cycle.
```

### 2b. Epic points + DF3.6 line edits

```yaml
    points: 45          # df1 block, yaml:109 — was 32 (+8 DF1.10 +5 DF1.11)
    points: 39          # df2 block, yaml:123 — was 34 (+5 DF2.10)
    points: 28          # df3 block, yaml:138 — was 24 (+4 DF3.7)
```

All three deltas verified against a hand sum of each block, not taken from the handoff.

DF3.6 line (yaml:146) — deps gain DF1.10, tag re-sequenced, note appended:

```yaml
      DF3.6: { title: "Resident-Agent Bounds — Iterations, RSS, and an Absolute Spend Ceiling Enforced by the Engine", points: 3, status: ready-for-dev, deps: [DF1.1, DF1.5, DF1.10, DF2.3, DF2.8, DF3.3] }  # v5-S3 — RE-SEQUENCED 2026-08-31 per ADR consequence 5 (was v5-S2). DF1.10 added: this story's in-box clauses stop being aspirational once the engine actually runs in-box, and it cannot be verified against a host-side engine. Re-validated clauses (df3-6…md): :69 bounds enforced at manifest load inside the box; :85/:90/:167-168/:254 the frozen-manifest-only cap rule (the host-side .sandbox/runs/<id>.json genuinely does not exist in-box — now by design, not by accident); :279 the DoD grep asserting src/phase-engine/ never reads .sandbox/runs/. NOTE :108-109/:136/:202-203 — the darwin `ps -o rss=` branch was justified by "DF3.3's e2e demo runs on the operator host"; with the resident in-box that justification is gone and the branch survives only as dev-host convenience. Re-tagged S3 because an S2 story cannot depend on an S3 predecessor.
```

### 2c. Meta block (yaml:32-39) — verified numbers

Replaces lines 32-38. Per-epic and per-sprint both reconcile; I recomputed each from the file rather than incrementing the handoff's figures.

```yaml
  # The totals above cover the v4 Phase 0 + Phase 1 slate only; they are NOT restated for the
  # Dark Factory v5 backlog. DF totals: 35 stories / 145 points (DF1 10/45, DF2 10/39, DF3 7/28,
  # DF4 2/10, DF5 5/17, DF6 1/6).
  # v5 totals verified to reconcile both ways: per-epic 45+39+28+10+17+6 = 145 (10+10+7+2+5+1 = 35
  # stories), and per-sprint-tag subtotals S1=48/S2=47/S3=50 -> 145 (S1=12/S2=12/S3=11 stories).
  # 2026-08-31: +4 stories / +22 pts for the in-box restoration arc (DF2.10, DF1.10, DF1.11, DF3.7,
  # all v5-S3) per ADR docs/superpowers/specs/2026-08-31-tier2-placement-adr.md; DF3.6 re-sequenced
  # v5-S2 -> v5-S3 (it now depends on DF1.10). Done to date: 25/35 stories, 103/145 pts.
  # The v4 fields above are the retired phase-0+1 slate, not a second v5 total. P1.18 is NOT
  # scheduled in the v5 window and is not counted in the DF 35/145 (see P1.18).
  # DF atomicity audits: sprint-artifacts/dark-factory-v5/atomicity-audit-{2026-08-11,2026-08-20,2026-08-31}.md
```

Also line 103 (`# Atomicity:` inside the DF header comment block) and line 98 (`31 stories / 123 pts`) need the same update; line 103 currently names only `2026-08-11` and was **already stale by one audit** (2026-08-20 was never added) — fix both while there.

### 2d. Sprint math, all four variants

Base (verified): 31 stories / 123 pts; S1 12/48, S2 13/50, S3 6/25. Done 25/103 after the DF3.4 correction.

| Variant | Stories / pts | S1 | S2 | S3 | Done |
|---|---|---|---|---|---|
| **A. Arc + DF3.6→S3, DF6.2 not absorbed** *(recommended; the block above)* | **35 / 145** | 12/48 | 12/47 | 11/50 | 25 / 103 |
| B. Arc, DF3.6 stays S2, DF6.2 not absorbed | 35 / 145 | 12/48 | 13/50 | 10/47 | 25 / 103 |
| C. Arc + DF3.6→S3 + DF6.2 absorbed | 36 / 147 | 12/48 | 12/47 | 12/52 | 26 / 105 |
| D. Arc, DF3.6 stays S2, DF6.2 absorbed | 36 / 147 | 12/48 | 13/50 | 11/49 | 26 / 105 |

The handoff's stated targets (35 / 145) match A and B — i.e. they assume DF6.2 is **not** absorbed. Every variant reconciles both ways (per-epic sum = per-sprint sum = total).

**Capacity note, unsolicited but load-bearing:** S3 goes from 25 pts to 50 (variant A) — the heaviest band in the plan, against a ~45-50 pt baseline. The arc doubles S3 single-handedly. That is the honest consequence of tagging all four v5-S3 and is worth stating in the wrap-up note rather than discovering at standup.

---

## 3. Drift corrections — each claim verified, three confirmed, one extra found

These are **separate commits** from the story-authoring commit, so the operator can read them independently.

1. **DF3.4 stale at `review` — CONFIRMED.** yaml:144 says `status: review`; PR #150 merged into `dev` 2026-08-31T19:41:26Z (merge commit `185291e`, at HEAD). Third instance of the drift shape the 2026-08-26 audit caught on DF3.1 and DF3.2. Fix: `status: done`, prepend `done 2026-08-31: PR #150 merged (185291e) after review rounds 1-10 + two CodeRabbit HIGH follow-ups (e7c8fb5 ownership-preserving migration lock reclaim)` to the existing note.
   *Commit:* `fix(sprint): DF3.4 done — PR #150 merged 2026-08-31`

2. **DF6.2 has no yaml line — CONFIRMED.** `grep -rn "DF6.2\|df6-2"` over both `sprint-status.yaml` and `sprint-status-history.md` returns **zero hits**. Story file exists (2 SP, `**Sprint:** v5-S3`); PR #136 MERGED 2026-08-28T12:48:05Z into `dev` (`decd385`). Draft line, to insert after `DF6.1:` (yaml:172):

```yaml
      DF6.2: { title: "dispatch_task Verdict Integrity — Refusals and Non-Success Classifications Settle the Phase FAIL", points: 2, status: done, deps: [DF1.1, DF1.6] }  # v5-S3 (unslotted fix; surfaced by PR #135 review round 5, fix-tests-b "found-but-not-fixed" #1) — done 2026-08-28: PR #136 merged to dev (decd385, branch commit bed4b57). Closes a hole in DF1.1's "success is earned" contract: a clean return carrying a non-success verdict was promoted to success. This line was never written at merge time; added 2026-08-31 during the in-box arc wrap-up. Absorbing it moves DF6 1/6 -> 2/8 and every DF total by +1 story / +2 pts.
```

   Deps `[DF1.1, DF1.6]` are inferred from the story's own Spec Reference (DF1.1's `phase.ts` lifecycle contract; DF1.6's `dispatch-task.ts`), not from an existing edge — flag as inferred so the operator can correct. **This is a decision, not a mechanical fix**: absorbing it moves every number to variant C. Recommend absorbing (a merged story invisible to the tally is exactly the drift class this audit exists to catch), but do it in its **own commit** with its own tally update so it can be reverted independently.
   *Commit:* `fix(sprint): add the missing DF6.2 line — merged 2026-08-28, never recorded`

3. **Header tally stale — CONFIRMED, and worse than claimed.** yaml:15 says "23/31 stories, 93/123 pts". Hand count of `status: done`: DF1 8/32 (all done), DF2 9/34 (all done), DF3 3/13 → 4/19 with the DF3.4 fix, DF4 2/10, DF5 2/8, DF6 0/6. **Real = 25 stories / 103 pts** post-fix (24 / 97 as the file stands). The header is two corrections behind — it predates both DF3.3 (4 pts) and DF3.4 (6 pts).
   *Rolled into the meta-block edit in §2c.*

4. **NEW — atomicity pointer stale by one audit.** yaml:39 and yaml:103 both name `atomicity-audit-2026-08-11.md` only; `atomicity-audit-2026-08-20.md` exists on disk and was never linked. Fix with the brace-expansion form in §2c.
   *Commit:* fold into the same `fix(sprint):` tally commit.

---

## 4. Story slugs + paths

Convention confirmed against all 32 existing files: `df{epic}-{n}-{kebab-title}.md`, lowercase, no zero-padding, epic and number separated by `-`. Two-digit story numbers have no precedent yet but follow mechanically (`df2-10`, `df1-10`, `df1-11` — no ambiguity, since the epic segment is always `df{1..6}`).

| Story | Path |
|---|---|
| DF2.10 | `/Users/steve/QDS-Factory/_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md` |
| DF1.10 | `/Users/steve/QDS-Factory/_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-10-in-box-phase-engine.md` |
| DF1.11 | `/Users/steve/QDS-Factory/_bmad-output/sprint-artifacts/dark-factory-v5/stories/df1-11-in-box-steering-executor.md` |
| DF3.7 | `/Users/steve/QDS-Factory/_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md` |

All four conform. Note the handoff's paths said `dark-factory-v5/stories/` without the `_bmad-output/sprint-artifacts/` prefix — the real root is `_bmad-output/sprint-artifacts/dark-factory-v5/stories/` (there is no top-level `dark-factory-v5/`).

---

## 5. Wrap-up artifact list

| # | File | Action |
|---|---|---|
| 1 | The four story files (§4) | **Create** — Phase 2 output, 13-heading template |
| 2 | `_bmad-output/sprint-artifacts/sprint-status.yaml` | **Nine edits**: 4 new story lines (§2a) · 3 epic `points:` (§2b) · DF3.6 line (§2b) · meta block lines 32-39 + the DF-header comment at 98/103 (§2c) |
| 3 | `_bmad-output/sprint-artifacts/sprint-status-history.md` | **Drain + append.** Header rule: "Append new notes here; drain them there." Move the current 2026-08-29 tech-debt-wave-0 note verbatim into a `## 2026-08-29` section (oldest-first ordering, tallies marked superseded per the file's own header), then append a `## 2026-08-31` entry for this planning run |
| 4 | `_bmad-output/sprint-artifacts/dark-factory-v5/atomicity-audit-2026-08-31.md` | **Create** — 4-story audit in the 2026-08-20 format: header (Auditor: qds-sprint-planning Phase 2.5 / Total stories audited: 4 (DF2.10, DF1.10, DF1.11, DF3.7) / Pass-Warn-Block / Context), then the same 8-row check table per story: normative ≤200 (BLOCK >250) · total ≤400 (WARN) · SP ≤8 (BLOCK) · DOD ≤10 (WARN) · title AND-connectors (WARN) · blocker markers =0 (BLOCK) · Files-to-Modify present (BLOCK if absent) · Security Invariants triggered+substantive (BLOCK). **Watch DF1.10 at 8 SP — it is exactly at the BLOCK ceiling**, and two titles carry an AND-connector (`DF1.11` "+ Channel Lifecycle"; that is a WARN with ample precedent — DF3.4 and DF3.3 both carry one). Date the file for the day the audit actually runs; use `-2026-09-01` if the wrap-up slips past midnight |
| 5 | `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` | **No edit.** ACCEPTED record. Its "Consequences" section already forecasts these stories; do not retrofit story IDs into it — the story files cite the ADR, not the reverse. (Optional: a dated appendix naming the four IDs, matching the existing "Appendix (2026-08-25): deferred-seam register" pattern in the derivation-decisions doc.) |
| 6 | The three 2026-08-11 spec docs | **No edit.** Closed records by their own header rule; neither indexes stories individually. (R5 verified this and it still holds.) |
| 7 | `/Users/steve/QDS-Factory/CLAUDE.md` | **No edit.** Carries no sprint/status line. Its only DF-relevant content is the branch-convention note (correct, dated 2026-08-28) and the `qds-live-e2e` pointer. |
| 8 | Git | Branch + PR per §6; `detect_changes()` before commit per repo CLAUDE.md |

**No `_bmad-output/epics.md`** — R5 verified its absence and it is still absent. The skill's Phase 3 §3.3 items that target it are no-ops here; the DF backlog's only index is the yaml comment block at lines 97-105 plus the story files.

---

## 6. Branch / PR / commit conventions — and the #182 stacking question

**Convention (verified):** prefix `feature/`, base `dev`, target `dev` (repo CLAUDE.md; confirmed in practice by PR #150 and #182, both `baseRefName: dev`).

**Branch:** `feature/df-inbox-arc-stories`

**Commit prefix — correcting R5.** R5 proposed `feat(df1-10): write the … story spec`, citing the v4-era `feat(sprint): author QDS-Factory v4 Phase 0+1 stories`. The **DF-era** precedent is `docs(...)`, verified from PR #101 (`docs(stories): derive Dark Factory v5 backlog — 31 stories/111 pts`, `docs(audit): F14 per-story disposition…`) and PR #122 (`docs(df3): harden fleet story specs against implemented DF1/DF2 architecture`). Story-spec authoring is documentation in this repo; `feat(...)` is reserved for the implementation (`feat(fleet): DF3.4 tier-1 pre-PR approval gate + attach steering`).

Proposed commit sequence (four commits, each independently revertible):

```
docs(stories): author the in-box restoration arc — DF2.10, DF1.10, DF1.11, DF3.7 (22 pts, v5-S3)
docs(df3-6): re-sequence onto DF1.10 and re-validate the in-box clauses
fix(sprint): DF3.4 done — PR #150 merged 2026-08-31; correct the 23/93 tally to 25/103
fix(sprint): add the missing DF6.2 line — merged 2026-08-28 (PR #136), never recorded
```

**PR title:** `DF in-box restoration arc: four stories (DF2.10, DF1.10, DF1.11, DF3.7) + DF3.6 re-sequence` — matches the DF-prefixed plain form of #182 and #150 rather than a conventional-commit subject.

**Issue wiring:** reference #180/#181 in the PR body and in DF1.11's Spec Reference. Do **not** put `Closes #181` on a spec PR — the ADR itself says "#181/#180 stay open with amendment comments" until the in-box consumer lands. `Fixes` belongs on DF1.11's implementation PR.

### Should the stories branch stack on #182? — **No. Land #182 first.**

The stories cite `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md`, which exists **only** on `feature/df1-10-tier2-placement-adr`. Cut from `dev` today and every Spec Reference points at a file not in the tree — unreviewable.

But stacking has a documented, recently-paid cost in this exact repo. The yaml header records it: squash-merging #141 orphaned the tech-debt stack's shared history, #147 went CONFLICTING, and its six commits had to be replayed with `git rebase --onto` — *"Every later wave will need the same replay as its parent merges."*

#182 is **docs and evidence only, no code**, already CodeRabbit-reviewed, base `dev`. There is no reason for it to become a stack root. **Recommendation: merge #182, then cut `feature/df-inbox-arc-stories` from the updated `dev`.** If #182 cannot land before Phase 2 writers start, then stack (`git checkout -b feature/df-inbox-arc-stories feature/df1-10-tier2-placement-adr`, PR base = the ADR branch), budget the replay, and re-target to `dev` the moment #182 merges.

---

## 7. Phase 2 writer alignment — shared patterns both writers must match

Wave plan: **writer 1 = DF2.10 + DF1.10** (the image → engine chain, where the placement argument lives), **writer 2 = DF1.11 + DF3.7** (the two consumers of the in-box engine). This split keeps the DF2.10→DF1.10 hard edge inside one head and gives writer 2 both stories that inherit DF1.10's contract. Writer 2 should start after writer 1 has drafted DF1.10's Technical Notes, or both writers must be given the §1 resident-ownership answer up front — it is the one decision that crosses the wave boundary.

**1. Invariant namespace — `INV-IBOX-*`, single namespace across all four.**
Verified taken: `INV-1..6` (generic, DF1/DF2 era), `INV-COST`, `INV-PR`, `INV-CRED`, `INV-APPROVE`, `INV-RV`, `INV-RUN`, `INV-BND`, `INV-RES`, `INV-AUDIT`, `INV-SC1..5`, `INV-SKILL`, `INV-GATE`, `INV-POLICY`, `INV-HM1..6`. `INV-IBOX-*` is **collision-free** (`grep -rn "INV-IBOX"` hits only prior planning research, no story and no source). Number `INV-IBOX-1..N` **continuously across the arc**, not per-story — the invariants are properties of the placement, not of one file cluster, and a reader tracing "the engine's credential surface" should not have to know which story wrote it. Assign ranges up front to avoid collision: DF2.10 `1-3`, DF1.10 `4-9`, DF1.11 `10-13`, DF3.7 `14-16`.

Cross-refs to existing invariants are cited **verbatim with owner** (`df3-4:257` form: `DF2.3 INV-CRED-3`). The three that matter here: `INV-RES-3` (one key, in-box — currently violated in substance; DF1.10 restores it), `INV-BND-2` (fail-closed missing cap — DF3.6's, unchanged), `INV-APPROVE-6` (teardown before promote — DF3.4's, and DF3.7 must not weaken it).

**2. PASS-shape language for live e2e.** The arc **inverts a PASS shape**, which is rare and must be written identically in both stories that touch it. Today the honest shipped PASS is `no-ack` / exit-6 (`df3-4:774` Deviation 12; the ADR's "Interim" paragraph). After DF1.11, PASS is `attach-acked`. Required in DF1.11's AC: name the old shape, name the new one, and state that the assertion **flips** — a test still passing on `no-ack` after DF1.11 is a false green. Both writers use the repo's existing vocabulary: **MANDATORY live e2e**, real box, real spend, `QDS_E2E_LIVE` tiers, evidence JSON under `_bmad-output/evidence/<story>/`, and the standing rule that **FakeDriver is forbidden as sole evidence** (DF3.4 AC6). Point them at the `qds-live-e2e` skill.

**3. ADR citation format.** Follow DF3.3/DF3.6's Spec Reference shape exactly — backticked path, then section, then a short parenthetical quote:

```markdown
- `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` (ACCEPTED 2026-08-31) — Decision; Consequences item N; the measured-substrate findings
- `docs/superpowers/specs/2026-08-11-dark-factory-v5-architecture-design.md` §5.1 tier 2, **D4** (`:301` "resident orchestrator agent per sandbox … operating a deterministic TS phase engine")
- Probe evidence (READ-ONLY): `_bmad-output/evidence/df1-10-probe/2026-08-31-232522-box-env-probe.json`
- Superseded (cited, not modified): `_bmad-output/workflow-state/qds-sprint-planning/df1-10-a/HANDOFF.md` §3 — the rescinded host-side "option 1"
```

**4. Cite measurements, never folklore.** The ADR's central finding is that the host-side placement rested on unmeasured premises — including a *fabricated citation* ("verified live T1.1: bun --version passed" — bun had never been probed). Every substrate claim in these four stories must trace to the probe JSON or to a fresh measurement. If a writer needs a fact the probe does not contain, the story says so in Technical Notes as an open measurement, and does not assert it.

**5. Shared non-goals, stated identically in all four.** (a) The approval gate **stays host-owned** — no story moves gate authority in-box. (b) **No field is added to DF2.1's closed run record**; new telemetry rides DF3.3's journal `resident` block. (c) **DF5.1 host re-verify is unchanged** — it is the second layer of R9's two-layer doctrine and the arc must not collapse it. (d) Integer micro-dollars only, never a ratio (DD-9 / R5 fact 12).
