# W3-STORY

Exclusive file: `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md`
(564 → 1002 lines). No other file touched. No commits, no staging, no push.

## Sections added/changed (with line ranges)

Line numbers are POST-edit unless marked "was".

| # | Where | What |
|---|---|---|
| 1 | `:201-212` (new) | **Status line** added at the head of the Dev Agent Record, in DF2.9's `**Status:**` convention (the story had none). States `in review`, names the branch/PR, and says **not mergeable as it stands** with the two reasons (A7 environment gap, stale pin), pointing at *What a human must do*. |
| 2 | `:253-268` (was `:242-245`) | **Deviation 1 rewritten for finding H1.** "13 files touched, not 10" → "43 files touched, not 10 — 50 once round 4 is committed", with the measured command, the grouped full list, and the three original design-driven gate-crossers kept. Ends with an explicit paragraph recording the **missing round-3 record** — commit `c52f4d0`, its thirteen fixes enumerated, and the fact that the commit message is the only record. |
| 3 | `:275-296` (new) | **Deviations 6 and 7** — the fleet fixer's D4/D5 text, folded in with only formatting changes (renumbered from his D4/D5 to the story's 6/7, sub-bullets re-indented, the caller-surface list compressed from a nested list to one dense line). Substance unchanged. Deviation 6 additionally carries D3b (the successful-compensation log line) and the named remaining `delivery_compensation` gap. |
| 4 | `:349` | Round-2 e2e paragraph: path updated to `tier2-image-contract.live.test.ts`, plus the rename rationale and the "evidence artifact NAME stays `t1-image-contract`" statement. |
| 5 | `:422`, `:456`, `:596` | The other three `tier1-image-contract` mentions updated, each keeping the historical name so past rounds still read correctly. |
| 6 | `:562-574` (was `:515-517`) | **Round-2 deferral marked SUPERSEDED, not deleted.** Original text struck through, followed by why it is false, what actually landed (round 3 + round 4's D1), a pointer to deviation 7, and the honest note that nobody *decided* to reverse it. |
| 7 | `:619-1002` (new) | **`## Review Findings — round 4`**, matching rounds 1/2's heading depth and voice: round shape → `### Patched — by area` (7 areas, triage IDs, one line each) → `### New findings — the tier1-* live files` → `### False positives` → `### Deferred` → `### What a human must do` → `### The tier1→tier2 rename` → `### AC5 attribution changed shape` → `### Gates after the round` → `### What this round did NOT do, stated plainly`. |

## The real touched-file count, and the list

`git diff origin/dev...HEAD --numstat | grep -v '_bmad-output/' | wc -l` → **43** committed paths.
The round-4 working tree is uncommitted and adds **7** more (`tier1-attach-transport`,
`tier1-driver-lifecycle`, `tier1-fanout-refusal`, `tier1-harvest`, `tier1-lock`,
`tier1-provision-status`, and the new `tier2-image-contract.live.test.ts`) → **50 distinct paths**.
Both numbers are in the story; the grouped list is at `:254-260`:

- CI / supply chain (6): `publish-exedev-image.yml`, `verify-image-pin.yml`, `dependabot.yml`, `image-pin-exceptions.json`, `.dockerignore`, `.claude/skills/qds-live-e2e/SKILL.md`
- Image (4): `oci/exedev/Dockerfile`, `binary-licenses.json`, `systemd/qds-run@.service`, `systemd/qds-steering.conf`
- Build script (1): `scripts/build-exedev-image.ts`
- Source (7): `exedev/{driver,setup-gate,transport}.ts`, `exedev/assertions-in-box.sh`, `src/providers/index.ts`, `src/providers/credentials.ts`, `src/fleet/fanout-primitive.ts`
- Unit / contract tests (9): `exedev/{image-contract,image-assets,read-box-file,setup-gate}.test.ts`, `exedev/fixtures/fake-exedev.ts`, `tests/providers/credentials.test.ts`, `tests/fleet/patterns.test.ts`, `tests/scripts/{build-exedev-image,exedev-bun-pin}.test.ts`
- Live e2e (22 paths / 21 files): `live-harness.ts`, `live-harness.test.ts`, all 19 `*.live.test.ts`
- Contract pin (1): `tests/gitnexus/cli-contract.ts`

Note for the round lead: `tests/gitnexus/cli-contract.ts` (+26/−1) is in the branch diff and I have
recorded it, but no fixer report explains it and it is not a DF2.10 surface. Worth one look before
merge.

## Claims I could not source (cut or marked)

Everything in the section traces to a fixer report, the triage ledger, or a measurement I made
myself. Five claims were corrected or hedged during the gate pass:

1. **CUT** — "nine `tier1-*` live files had never been reviewed by anybody in four rounds."
   W2-LIVE's header says "reviewed by nobody **this round**", and three of the nine
   (`tier1-registry-auth`, `tier1-approval-gate`, `tier1-teardown`) demonstrably *were* in this
   round's chunking (edge-live-t1's F1/F3/F7/F8/F13, and F4). Replaced with the hedge carried
   explicitly: "the fixer's report calls all nine previously unreviewed; carry the hedge — read it
   as six genuinely unopened plus three opened for other reasons." Same correction applied to the
   heading and to the file-list line.
2. **CUT** — "wired into 11 bodies in wave 1." FIX-LIVE-T2345's prose says 11 test bodies; its own
   roster table ticks ten. Irreconcilable from here, so the count was removed and the discrepancy
   is named in the story with the durable substitute
   (`grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts`).
3. **MEASURED, not inferred** — "`bunx tsc --noEmit` 0 repo-wide." The chronologically last wave-2
   report (W2-CONTRACT, 23:02) still showed one residual `TS6133` in
   `tier3-manystories.live.test.ts`. I ran `bunx tsc --noEmit` myself: exit 0, no output. The story
   says so, and says the residual is gone.
4. **HEDGED** — "the one fail-OPEN shape in the round" (C4). The ledger's phrasing is scoped to
   cluster C. Narrowed to "the one fail-OPEN shape the reviewers found."
5. **HEDGED** — the wave-3 transport MEDIUM. `W3-TRANSPORT.md` never appeared while I worked, so
   the deferred-items entry states the defect from W2-CONTRACT's own report and then says
   explicitly that a fix was in flight, that its report had not landed, and that the reader should
   check `transport.ts` rather than trust the paragraph.

Two further arithmetic corrections made against the reports rather than asserted: the cluster
headers ("14 of 17" → "15 rows touched, 14 fully patched", "4 of 5" → "all 5 with D3a refuted",
"16 of 17 patched **and** F17 patched" → "all 17, though the ledger classified F17 as deferred"),
and the deriveBuildId-input list gained **E8** (the BUMP PROCEDURE edit is Dockerfile bytes too).

**One claim is from the coordinator's brief and not from any fixer report:** "13 fixers across two
waves". The `fixes/` directory holds 12 reports plus mine. Left as briefed, flagged here.

## Anything in the fixer reports that CONTRADICTED another report, and how I resolved it

1. **`keyLeakProblems` body count (FIX-LIVE-T2345 internal).** Prose "11 test bodies" vs its own
   roster's ten ticks. → Count dropped from the story; discrepancy named; grep given as the durable
   answer.
2. **Key-leak coverage claim (W2-DOCS vs W2-LIVE).** W2-DOCS measured `tier2-image-contract` at
   ZERO `keyLeakProblems` and two tier-1 minting files uncovered, and wrote SKILL.md to a dated gap.
   W2-LIVE then wired exactly those four bodies. → Resolved as sequence, not conflict: the story
   states that **after wave 2 every minting body carries the verdict**, that SKILL.md's prose
   therefore now *under*-claims because it was written first, and that the durable grep it gives is
   correct either way. The story also says this is a **static wiring claim** — nothing has executed
   `keyLeakProblems` against a real account.
3. **`bunx tsc --noEmit` state.** Five reports show five different non-zero snapshots, each
   attributing its errors to another fixer's in-flight edit; W2-LIVE says exit 0, W2-CONTRACT
   (later) says one error. → Resolved by re-measuring: exit 0 now. Story records the final state
   *and* the mid-round churn with its attribution.
4. **`bun test tests/fleet/` pass count.** 1051 (concurrent, 8 fail), 1054, 1058 (1 fail), 1059.
   → Reported as the range with the failures attributed: the 8-fail run was concurrent-load
   (seven run-lock ENOENT races in `patterns.test.ts`, one multi-second KDF test in
   `approvers.test.ts`), both green in isolation.
5. **`tier1-image-contract` residual references.** FIX-LIVE-T1 listed three `scripts/` references
   and one `SKILL.md` line as unowned leftovers; W2-CI independently flagged the same three;
   W2-DOCS then landed all of them. → No conflict, just staleness across time; the story records the
   rename with one deliberate survivor (`SKILL.md:95`, a dated historical sentence).
6. **A14 (FIX-CI) vs the reviewer.** Not a report-vs-report conflict but a fixer refusing a finding.
   Recorded in the story as a false positive **with all three pieces of evidence and the fixer's
   standing offer to build it anyway** — including the `actionlint` output proving `environment:`
   is illegal on a reusable-workflow call, which is the part that makes it a real trade rather than
   laziness.
7. **E13 (FIX-OCI) vs the reviewer's prescription.** The finding's own fix
   (`ConditionPathExists=`) would have been fail-OPEN. Recorded as a *partial* false positive: the
   goal was met, the prescribed directive was not what shipped, and the reason is stated so nobody
   "corrects" it back.

## Rules I held to

- No live-round claim: the story says plainly that **no box was provisioned and no money was spent**
  this round, that every gate was offline with `QDS_E2E_LIVE` unset, and — the part that matters —
  that **every live-e2e fix in this round is therefore unexercised on real substrate**, and cannot
  be exercised until the image is re-pinned.
- Hedges carried, not laundered: A13's untested `DELETE` permission, pi's unexercised `paths` entry,
  E10's "narrowing does not make pi tamper-proof", B19's docblock-only ceiling, the `attest` job
  still being the least-exercised code in the PR, and the fact that this section is currently the
  only durable record because `/tmp/pr184-r4/` was never copied into
  `_bmad-output/workflow-state/code-review/pr184/` the way rounds 1 and 2 were.
