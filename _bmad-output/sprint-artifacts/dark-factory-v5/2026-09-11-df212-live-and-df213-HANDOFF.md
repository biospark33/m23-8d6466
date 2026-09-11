# HANDOFF — DF2.12 live round + done-flip, then DF2.13 (written 2026-09-11 ~16:30 EDT)

**Written for a fresh session.** Everything below was verified against the tree today, not
carried forward. Session 2 = this file's whole job list. Waves 7–8 are deliberately NOT here —
they get their own third session with fresh context (operator decision).

---

## 1. Rules that outrank everything (unchanged, all binding)

> **Open the file before ratifying anything.** Never rule from an agent's description; never
> relay a finding — point at the report. **Cite by symbol, never line.** A worker's "gates
> green" can be true of its files and false of the suite — run FULL affected suites at the
> parent. Don't assume a fixed finding is fixed. If a subagent pushes back with evidence,
> check the evidence.

- `/unlazy` for multi-step work; **`/qds-dev` for every story dev** (operator directive).
- `qds-live-e2e` skill for any live round; never fakes in a live gate.
- Full suites tee'd to a log you own, then parse failures out of it (CLAUDE.md ritual).
- Image inputs: any edit to `src/phase-engine/`, `src/fleet/`, `src/providers/exedev/` (driver),
  `scripts/lib/`, `scripts/pipeline-run.ts`, `package.json`, `cli-anything/src/`, the systemd
  unit, tmpfiles conf moves a pin — including comment-only edits. Adopt in-commit; republish
  rides the merge/push.
- Unlazy ledger for the DF2.12 finish line: `.unlazy/df2-12-closeout/GATES.md` — G1–G9 MET with
  evidence; **G10 (TIER-2 live round) and G11 (done-flip + slate) are the unmet remainder.**

## 2. Where things stand (all verified 2026-09-11)

- `dev` @ `075eeb0a`, pushed, synced with origin. **DF2.12 is MERGED** — PR #253 (`280dfb93`),
  operator-approved after 6 further review rounds on the PR (commits `9102b7c9` → `53a50b99`:
  run-scoped `invocationSeq`, honest unpriced metering, refusal isolation, loser token ingest,
  bridge wedge-proofing — the story's Dev Agent Record on dev is current through round 6).
  **PR #252 also merged** — the Wave-7 charter now lives on dev at
  `_bmad-output/sprint-artifacts/dark-factory-v5/2026-09-10-wave7-HANDOFF.md`.
- Branch `feature/df2-12-token-cost-attribution-wiring` pruned local+remote; stale worktree
  removed; no local-only commits remain (the pre-session handoff doc was superseded — its
  archive sits at `/tmp/archive-df212-finish-handoff.md`, do not restore it).
- **Eighth pin adopted** (`075eeb0a`): `DEFAULT_IMAGE_REF` →
  `sha256:1ee61c011d87cc3fe49196a2f4ae1d09f738b55d2b1c1f9a54fe1804d647e957`,
  `DEFAULT_IMAGE_BUILD_ID` → `6f47990422b70761`, at driver.ts AND the image-contract marker
  pairing (four sites total — the review rounds retired the old test-literal shape and
  re-adopted the tracked-inputs literal to `e52c8135…`).
- Publish workflow's first post-merge run (`34642063966`) failed BY DESIGN (the printed-pair
  dispatch — its own log says a push touching driver.ts heals it); the healing run
  (`34646842629` on `075eeb0a`) was in_progress at handoff time. **First act: confirm it went
  green and `verify-image-pin.yml` followed** — that closes G9's last inch. Do NOT re-run the
  failed run; its own output forbids it.
- Slate: DF2.12 `ready-for-dev` (correct — not done until the live round), DF2.13
  `ready-for-dev`. Everything else untouched.

## 3. Read order

1. This file.
2. DF2.12 story Dev Agent Record (dev is the truth): deviations 1–8 + the round-6 record +
   findings dispositioned (loser-arm gap RESOLVED round 6; `usdToMicros` ≤1 µ$ drift above
   ~2^51 still owed, pinned at the property test; live assertions owed to the live round).
3. `qds-live-e2e` skill (`.claude/skills/qds-live-e2e/`) — required for step 4(i).
4. DF2.13 story (pre-dev repairs already on dev — `bbb10b49` verified in origin/dev history).
5. Sprint-status.yaml + `bun scripts/check-story-consistency.ts` — the gate.

## 4. The job, in order

### (i) DF2.12 finish line

1. Confirm publish run green + `verify-image-pin.yml` green on dev (G9 closes). If the fresh
   run printed a THIRD digest instead of going green, the build is not reproducible — stop and
   investigate; never keep re-pinning.
2. **TIER-2 live round** (`qds-live-e2e` skill; **operator-gated spend — ask before spending**;
   DF2.11 round-6 pattern): one real lead + 2-worker + armed-resident run through
   `qds-run@<runId>.service`, then `sandbox-teardown`. Capture: the harvested
   `<runsDir>/<runId>-artifacts/<runId>.engine.log` (one `cost_attribution` line per cost
   event) + the resulting ledger rows (role-split, resident row present) + the `qds cost`
   TOKENS cell. This proves the three flipped live assertions — now hardened per-arm plus a
   SUM cross-check against the record's spend (round 6). Evidence convention:
   `_bmad-output/evidence/df3-e2e/<date>-*` (DF2.11 round-6 precedent).
3. Flip DF2.12 → `done` in sprint-status.yaml + the story header; **recompute the slate (never
   increment)**; consistency checker must stay green. Closes G11.

### (ii) DF2.13 via `/qds-dev` (3 pts, mechanically small)

- Story: `df2-13-per-run-key-cap-from-admission-budget.md`. Cut the branch from dev (post-merge
  — already satisfied). Deps DF2.3+DF2.8 done; independent of DF2.12's live round.
- The change: ONE refusal condition in `mintRunKey`'s pre-mint ladder
  (`capMicroUsd > defaultKeyCapMicroUsd` → `cap-invalid`, message naming both values) + the
  `dispatch.ts` stale-comment correction + tests. Same edit owns dropping `credentials.ts`'s
  own `:261`/`:281` self-citations (W6-E-M8). The six-hop trace was verified exact by W6-E;
  re-verify citations at source before editing (they may have shifted — the PR's review rounds
  touched neighbors).

### (iii) Then stop — waves 7–8 are a third session

Hand the operator a short closeout: DF2.12 done + slate recomputed, DF2.13 merged (or its
state), and the pointer that Wave 7 starts from the charter now on dev (§4(ii) seam-ownership
tables; §5 settled rulings do-not-re-litigate; §8 bans). Wave-7 notes that survive contact with
today: DF3.6a resolves the METERING BASIS first (design decision, not arithmetic) and
re-derives against DF2.12's now-landed token rows (`role='resident'` rows exist; the per-run
p50 query shipped in `tests/providers/cost-ledger.test.ts` — use what landed). DF5.3/DF5.4 can
assert real token rows. The charter's "GitNexus index STALE" line is outdated — re-check index
freshness at that session's start.

## 5. Small parent-owned queue (optional, not blocking)

- `scripts/install-gitnexus-plus.sh`: progress echo says "300s cap" while caps are 600s
  (cosmetic); the perl fallback kills only the wrapper so the stamp step can be skipped
  (observed 2026-09-10). NOT COPY-walked inputs — fixing moves no pin.
- Reindex GitNexus (`bash scripts/install-gitnexus-plus.sh`) before impact/context work — the
  index predates the merge.
- Dependabot PRs: still not this campaign's business.

## 6. Known CI noise (triage, never blind-override)

- **Bun crash** `us_create_timer: returned null: 24` (#250) — intermittent, all branches;
  documented `--admin` precedent (#246, #251, and today's #253).
- **DF2.11 teardown-race timing flake** (`e2e TRUE contention`) — failed on `fix/exeuntu-base-repin`
  and `fix/df2-11-review-round3` CI before DF2.12 existed; 10/10 green locally; load-sensitive.

## 7. What NOT to do

- No new stories without a named owner per deliverable. No prose-patch rounds on the nine.
- Never loosen the gitnexus contract schema; never exclude `tests/gitnexus/`; never a bare
  `bun test` without a tee'd log; never a bare `gitnexus analyze`.
- No line-number citations in anything you write. No editing done stories' dev records beyond
  factual nits.
- Don't brief verifiers with fix recipes or author self-doubts.
