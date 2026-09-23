# DF3.6b — code review round 4 (post-rebase integration)

**Date:** 2026-09-19 · **Scope:** `feature/df3-6b-resident-memory-cgroup` rebased onto the current
`origin/dev` (which moved by PR #265/#267/#268, DF3.8) · **Focus:** semantic conflicts the textual
rebase could not see, and the one conflict that had to be resolved by hand.

4 findings (1 HIGH, 1 MEDIUM, 2 LOW). All resolved in-round.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | HIGH | **The rebased commit carried `PLACEHOLDER_WALK_DIGEST`, not a digest** — the branch as committed was red, and the Dev Agent Record claimed green. | Held deliberately: this file's own discipline is "re-pin LAST, after the last fixer lands", so the value is re-derived and amended into the commit only after every review fix in this round lands. The record's verification paragraph was also rewritten to state the exact scope and the known-unrelated failures instead of claiming a blanket green. |
| 2 | MED | **The ledger paragraph blamed a file that cannot move the hash.** It named `oci/exedev/Dockerfile` as one of five walked buildId inputs. The Dockerfile is `deriveBuildId`'s own separate `dockerfile` field; this literal is computed strictly over `files()`, which `buildIdFileInputs` returns as 89 entries with the Dockerfile absent. Four inputs moved it, not five. A provenance note naming the wrong cause sends the next re-pinner to bisect files that cannot move the hash — the same error this ledger already carries a correction for. | Verified independently by calling `buildIdFileInputs` directly (89 entries, Dockerfile absent, unit present), then the paragraph corrected to four inputs with the Dockerfile's separate role stated. |
| 3 | LOW | **The new entry broke the ledger's self-identifying prefix.** Every prior paragraph opens with the value it produced (`8fb0156e: moved from 5d5b84b6 …`); the DF3.6b entry opened with prose, leaving the current literal the only one in the chain a reader cannot tie to its paragraph. | The entry now carries its digest prefix, filled with the value at re-pin time. |
| 4 | LOW | **Two stale line citations the branch carried.** The story cited `src/providers/exedev/driver.ts:395,425` for `deriveBuildId`'s inputs — wrong at every base, and dev has since shifted `:425` onto a different paragraph — and `src/phase-engine/steering.ts:26` for `SOLICIT_TIMEOUT_MS`, which is at `:30`. | Both corrected against source (`scripts/build-exedev-image.ts:614` and `:1544`; `steering.ts:30`), with the wrong-at-every-base citation named as such rather than silently swapped. |

## Verified clean (no finding)

- **DF3.8 interaction**: dev touched `src/fleet/{observe,verbs}.ts`, `scripts/{fleet.ts,lib/run-lock.ts}` and `src/providers/exedev/driver.ts`. `src/fleet/resident.ts` imports none of them and `observe.ts` imports nothing from this story's three source files. No shared symbol, type or call edge.
- **Pin collision**: dev's thirteenth-pin adoption moved `DEFAULT_IMAGE_REF`/`DEFAULT_IMAGE_BUILD_ID`. This branch touches neither, and no branch file references a superseded pin literal (all six greppped). The "publish still owed" note reads correctly against the new pin.
- **Conflict resolution**: both DF3.8 ledger paragraphs preserved intact and in order ahead of the DF3.6b entry; no duplication, no contradiction. All three PINNED asset digests verified against `shasum -a 256` on the post-rebase tree.
- **Edit (vii)'s `exitStatus === null` guard**: the only writer of `telemetry.exitStatus` is the new overflow arm, initialized null, so the probe still fills the field on every pre-DF3.6b path. Not a regression.
