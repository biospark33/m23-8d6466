# Documentation-integrity review — round 1's story edits (chunk-docs.diff)

Scope: `/tmp/pr184-r2/chunk-docs.diff` (DF1.10 + DF2.10 story edits) and the full current
`_bmad-output/sprint-artifacts/dark-factory-v5/stories/df2-10-factory-owned-boot-image.md`
("Review Findings — round 1" section, lines 352–425), verified against the repo at
`f10880c` (feature/df2.10), issues #186–#190, the round-1 triage ledger
(`_bmad-output/workflow-state/code-review/pr184/round1-triage.md`) and round-1 reports.

## Verified TRUE (spot-checked both sides — no finding)

- **9 reviewers** = 4 blind + 4 edge + 1 auditor, matches both the story and the triage ledger header.
- **118 / 9 / 8 headline** matches the triage ledger verbatim ("Raw findings ≈156 → 118 patch / 9 defer / 8 dismiss"). Triage tables: dismissed X1–X8 = 8, deferred D-1–D-9 = 9, decisions Q-1–Q-6 = 6. **6 conservative decisions** = Q-1..Q-6, one-to-one with the story's numbered list.
- **Net new tests +103** is arithmetically consistent with the story's own two suite runs: 4861 − 4758 = 103.
- **`tests/scripts/build-exedev-image.test.ts` — "72 tests"**: exists; `bun test` runs exactly **72 pass** (84 ms).
- **`tests/providers/exedev/image-assets.test.ts` — "15-row mutation table"**: exists; the mutation table has exactly 15 entries (14 tests, table-driven).
- **`KNOWN CEILING` test** (`build-exedev-image.test.ts:606`) and **`KNOWN GAP` test** (`:280`) exist with exactly the claimed names/subjects.
- **`assertRegistryAuthDeviation`** exported at `src/providers/exedev/driver.ts:381`, called at `:502` — AC4 gate exists as claimed.
- **`transport.ts:360`** — accurate: `marker.imageRef` is reported, never compared, with the D7-mirror comment, at `src/providers/exedev/transport.ts:360-368`.
- **`driver.ts:28`** — `import { readFileSync, statSync }` is on exactly line 28; the dismissal is sound.
- **`dispatch.ts:2911-2917`** — the prior-regression comment exists at `src/fleet/dispatch.ts:2909-2917` (file is `src/fleet/dispatch.ts`, not `src/dispatch.ts`, but the record cites it as a bare `dispatch.ts` which resolves).
- **`docker cp -L` fix** — both `extractNodeModules` (`scripts/build-exedev-image.ts:1068,1072`) and the cert path (`:858`) use `-L`; `sweep.unreadable`/`unresolved`/`missingTexts` are now read (`:1627` area).
- **`readBoxFile` via `execTimed`** — confirmed by comments/code at `setup-gate.ts:476-482`.
- **Live evidence** — both cited files exist: `_bmad-output/evidence/df3-e2e/2026-09-01-114112-t1-image-contract.json` (PASS round) and `…-113654-…` (first round).
- **"the full ordered teardown trace is recorded in the round's report"** — it is: `round1-reports/test-live.md:133` "## Ordered teardown trace (after these changes)".
- **Decision-6 "MEASURED" build** — recorded in `round1-reports/fix-buildscript.md` (B11 row + "newly-uncovered binaries" section; bun at a new PATH, covered).
- **Issues #186–#190** — all exist, all OPEN, titles and scopes match the story table row-for-row (#186 re-pin bundle w/ 11 checkboxes incl. ProtectSystem, #187 tag-is-a-digest-input, #188 basename attribution, #189 live-harness teardown, #190 supply-chain posture). All five carry acceptance checklists, as both stories claim.
- **DF1.10 cross-refs** — DF1.11's INV-IBOX-13 (`df1-11-…md:124`) and DF3.7's AC4 (`df3-7-…md:124`) both exist and do rest on env-surface completeness, as the DF1.10 note claims.

## F1 [MEDIUM] The Deferred section and issue #189 describe harness defects the same branch has since fixed — the record is now stale against its own PR

- Story (`df2-10-…md:400`): "`revokeQuietly`/`destroyQuietly` root causes **live in** `live-harness.ts` — three live tests **now each carry the same guard because the shared helper does not**." Issue table (`:420`): "#189 … Not blocked on anything — pick up any time."
- Repo: commit `b45b72f` ("teardown can no longer skip the destroy, and the live suite drives the production driver (#189)") landed **after** the docs commit `0f94df5`, on this same branch. `store.get(runId)` is now **inside** `revokeQuietly`'s try (`tests/fleet/e2e/live-harness.ts:520-521`), the three per-caller guards are deleted (the commit message says so; `tier1-image-contract.live.test.ts:523` now cites "#189 — never throws"), and `destroyQuietly` returns an assertable verdict.
- Issue #189 is still **OPEN** and its body still describes the pre-fix state (":484 sits above the try").
- Every claim was true when written; it is false at current HEAD of the branch the story ships on. The Deferred bullet, the #189 table row and the issue body need reconciling before merge, or the story will tell a post-merge reader that undone work exists which the same PR already did.

## F2 [MEDIUM] "`boot_ready_ms` … exists nowhere" is no longer true — the branch implemented exactly the remedy the story proposes, and the story still says nothing emits it

- Story (`:401`): "`boot_ready_ms` is named in the Observability Contract and **exists nowhere**"; closing paragraph (`:425`): "present **nowhere in the repo** … the honest measurement point is gate A in `setup-gate.ts`, and the item was never routed."
- Repo: commit `f10880c` (top of branch, after the docs commit) emits it at `src/providers/exedev/setup-gate.ts:426` (`boot_ready_ms: aOk ? Date.now() - gateStart : 0`) — gate A, precisely the point the story names as honest.
- Same class as F1: the round-1 record's present-tense deferral is contradicted by the branch it rides on. The [Review][Defer] checkbox at `:401` and the `:425` paragraph should be updated to record the discharge.

## F3 [LOW] The headline "9 deferred, 8 dismissed" cannot be reconstructed from the story's own sections — the numbers come from the triage ledger's grouping, and the story's prose enumerates a different set

Both headline numbers are real (they match triage D-1..D-9 and X1..X8 exactly). But internally:

- **Deferred:** the story's "Deferred — real, with a reason" section (`:396-401`) lists ~12 distinguishable items across 6 bullets: the 5-item bundle (D-1..D-5) + basename + `parseBaseRefs` + the major-tag/environment/attestation trio (D-6..D-8) + harness + `boot_ready_ms`. Four of those (basename, `parseBaseRefs`, harness, `boot_ready_ms`) are **not** among the triage's 9 (they live in triage *patch* clusters W1-B/W2-C/C9 as half-deferred remainders), while D-9 ("the workflow has never executed") — which **is** one of the 9 — appears not here but under "Known limitations" (`:409`).
- **Dismissed:** the paragraph (`:405`) enumerates ~10–11 items against the headline 8: "four SKILL.md claims" (triage has three SKILL-related rows, X4–X6), plus `remediation.includes(secret)` and "two B0 budget findings," none of which are in the X1–X8 table.
- No number is fabricated, but a reader auditing the section against itself gets 12 and ~11 where the header says 9 and 8. One clarifying sentence ("counts follow the triage ledger's grouping; some patch clusters carry half-deferred remainders listed here too") would close it.

## F4 [LOW] Four line references read as current pointers but are pre-fix positions in the reviewed diff

- `setup-gate.ts:440` (`:360`) — line 440 today is assertion-A porcelain handling; the fixed B0/`readBoxFile` code is at ~476–512.
- `scripts/build-exedev-image.ts:679,683` (`:361`) — today that is `dockerfileArgDefault`/`readInput`; `extractNodeModules` is now at ~1063–1072.
- `live-harness.ts:484` (`:377`, and issue #189's body) — `store.get` is at :521 today (and inside the try, per F1); :484 is `destroyQuietly`.
- `license-sweep.ts:288-296` (`:361`) — file is `scripts/lib/license-sweep.ts` and the dangling-symlink→`unreadable` classification sits at ~290–300 (close, and the substance is exactly as described).

All four claims are substantively true; only the coordinates drifted as the fixes moved the code. `transport.ts:360` and `driver.ts:28`, by contrast, are still exact.

## F5 [LOW] Minor count/wording drifts against the triage ledger

- "Build script — **24** items" (`:367`) vs triage W1-B header "(**25**)" — the triage cluster includes one item in `tests/scripts/exedev-bun-pin.test.ts`, which the story's bracket (`scripts/build-exedev-image.ts` only) excludes. Defensible, but the two records disagree on the number.
- DF1.10's note says the deferred work is "**ten** image-content items … **all blocked on one fact**" (`deriveBuildId` digest invalidation). Ten is reachable only under one particular split of #186's bullets (+#187 +#188), and #188's own issue states its blocker is "needs a build to enumerate real installed paths" — it *closes at* the re-pin because a build happens then, but it is not blocked by the digest-invalidation fact. Slight overclaim, not a misdirection.
- DF1.10's hardening list includes `ProtectSystem` (matching issue #186's body) while DF2.10's deferred bullet (`:396`) omits it — the issue is the superset, so no reader is misled, but the two story files quote the same bundle differently.

## Not verifiable at reasonable cost (no contrary evidence found)

The full-suite gate line (`4861 pass / 7 fail`, "133/133 green on isolated re-run"), biome's "307 files," and the mutation-kill counts for `deriveBuildId` ("dropping `systemdFiles` reddens 5 tests," etc.) were not re-run; nothing contradicts them, and the adjacent verifiable numbers (72 tests, +103 net) all checked out.
