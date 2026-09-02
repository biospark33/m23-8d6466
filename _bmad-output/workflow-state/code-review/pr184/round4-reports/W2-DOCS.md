# W2-DOCS

## Patched

| Task | File:line | What changed | Why |
|---|---|---|---|
| 1 | `scripts/build-exedev-image.ts:2573` | `coldBootSource: "tests/fleet/e2e/tier1-image-contract.live.test.ts …"` → `tier2-image-contract` | DATA value written into `build-evidence.json`; it names the file that boots the pinned digest and that file no longer exists under the old name. Highest-value of the three. |
| 1 | `scripts/build-exedev-image.ts:2022` | comment `` `tier1-image-contract.live.test.ts` reads that exact default path for AC7c`` → `tier2-image-contract` | dangling rename |
| 1 | `scripts/build-exedev-image.ts:2139` | comment `the live-e2e reader (tier1-image-contract)` → `tier2-image-contract` | dangling rename |
| 1 | `.claude/skills/qds-live-e2e/SKILL.md:61` | roster-path table, harness arm: "the one caller today is `tier1-image-contract.live.test.ts`" → `tier2-image-contract` | dangling rename. Claim re-verified: `grep -rn rosterPath tests/fleet/e2e/*.live.test.ts` returns exactly one hit, `tier2-image-contract.live.test.ts:415`. The OCI fixer's `QDS_EXEDEV_ROSTER`-vs-`dirname(manifestPath)` two-arm table is untouched. |
| 1 | `SKILL.md` tier table (~83–86) | `tier2-image-contract` folded into the ordinary **tier 2** row (with the "setup gates C/D/E" cost note preserved); `tier5-gate-steering` given its own `5 (misnamed)` row at the bottom, as the only remaining file whose prefix lies | it is no longer misnamed; keeping it in a "misnamed" bucket re-creates the trap |
| 1 | `SKILL.md` ~88–101 | "prefix is not the gate" paragraph rewritten: only `tier5-gate-steering` still qualifies; added the fact that `liveGate` accepts only `"1"`/`"2"` so "tier 3/4/5" is a roster label, never an env value; added a short dated note recording the rename and the failure mode that forced it | the "two files spend money despite their prefixes" sentence was false after the rename, and the operator needs to know a `tier1-*` glob was the thing that broke |
| 2 | `SKILL.md:37` | env block comment `# 1 for tier-1, 2 for tiers 2/3/4` → `# 1 for tier-1; 2 for EVERYTHING else — liveGate takes only "1"\|"2"` | stale: tier5 exists now and `2/3/4` reads as if `QDS_E2E_TIER=3` were valid. Verified by survey: every non-tier1 file calls `liveGate("2")`. |
| 2 | `SKILL.md` — new section **"Evidence, and the harness contract every tier leans on"** (after the run-order paragraph) | documents (a) the evidence artifact's stamped `writtenAt` + `image` `{ref,buildId,overriddenBy,isRepoPin}` keys and how to use `image` to prove which bytes a round proved, including the `{note: "preflight did not run …"}` case; (b) a table of the six harness cleanup primitives and the verdict each returns | items 2.1 and 2.2. SKILL.md documented NONE of the harness primitives and nothing about evidence shape beyond "one redacted JSON per run" — this is the file an operator reads before spending money, and the F16 `image` stamp is unusable if nobody knows it is there. |
| 2 | `SKILL.md` "Before declaring the round done" | key-leak bullet: a green run in tier2-{dispatch-engine,fanout-bestofn}/tier3-*/tier4/tier5 now PROVES no key hash outlived it, because `keyLeakProblems` runs in those bodies' `finally`; a teardown exiting 0 without revoking now fails the round. `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts` given as the durable roster, with the manual `listedKeyHashes()` before/after retained for files not in it | item 2.3 — "what a green round proves" can now claim more, but not everywhere (see False positives) |
| 3 | `oci/exedev/binary-licenses.json` `$comment` | the "Known ceiling … the diff is BY PATH" paragraph replaced by two: (a) the diff is by PATH **and** CONTENT (`baseBins.get(p) !== sha`), so a re-pinned `pi` at a base-owned path IS flagged and MUST be attributed; (b) the surviving ceiling is on the COVERAGE side — basename coverage, optionally narrowed by `paths` — with `paths`' semantics spelled out (present ⇒ basename AND full in-image path, no leading slash; absent ⇒ basename anywhere, the pre-field behaviour; empty/absolute ⇒ validation failure, never a silent widening) | the old paragraph asserted the opposite of what the code does. No data field touched; the wave-1 `NOASSERTION` CORRECTION paragraph left verbatim. |

Semantics re-verified against source before writing the prose:
`scripts/build-exedev-image.ts:2416` — `const added = [...builtBins].filter(([p, sha]) => baseBins.get(p) !== sha)…`
(`listExecutables` returns `Map<path, sha256>`), and `uncoveredBinaries:1764` —
`entries.some((e) => e.names.includes(path.basename(p)) && (e.paths === undefined || e.paths.includes(p)))`.
`validateBinaryLicenses:1598` rejects a present-but-empty `paths`, a non-array, and any leading-slash member.

## Remaining `tier1-image-contract` references, with owners

| file:line | text | owner |
|---|---|---|
| `.claude/skills/qds-live-e2e/SKILL.md:95` | ``​`tier1-image-contract` was RENAMED to `tier2-image-contract` on 2026-09-01 for this reason …`` | MINE — deliberate. The only remaining occurrence in the repo (excluding `_bmad-output`), and it is a historical statement about the old name, not a pointer to a file. Removing it would delete the record of why the glob broke. |

Everything else cleared during this wave. `tests/fleet/e2e/live-harness.ts:100,110,131,530` still carried
the old name when I started; the parallel `tests/fleet/` fixer landed those four while I worked (verified
by re-grep at the end — all four now read `tier2-image-contract`). No `.yml` ever referenced it.
`_bmad-output/workflow-state/code-review/pr184/**` holds 10+ round-1/round-2 report files naming
`tier1-image-contract`; those are historical review artifacts, excluded by the gate's grep filter, and
not owned here. No `docs/` or story file outside `_bmad-output` references it.

## SKILL.md staleness found beyond the listed items

1. **`QDS_E2E_TIER=2  # 1 for tier-1, 2 for tiers 2/3/4`** — omitted tier 5 and read as if `3`/`4` were
   valid env values. They are not: `liveGate(tier: "1" | "2")`. Fixed (see table).
2. **Roster/tier table checked file-by-file against `ls tests/fleet/e2e/`** — the tier-1 list (9 files),
   tier-3 list (5 files) and tier-4 entry are all exactly right; nothing missing, nothing phantom. The
   only defects were the two the rename caused. `live-harness.test.ts` is a unit test of the harness,
   not a live file, and is correctly absent.
3. **Not changed on purpose:** the OCI fixer's `QDS_EXEDEV_ROSTER` two-arm table (lines 55–74) is
   accurate against `src/fleet/dispatch.ts` and `preflight()` as they stand; I edited only the one
   filename inside it.
4. **Not changed, flagged instead:** the "Failure triage protocol" tells the operator to read the
   evidence JSON first but never mentions `image`. I left it and put the fact in the new evidence
   section rather than duplicating it in two places — a second copy is a second thing to keep current.

## False positives

1. **"A key-leak verdict now runs in the tier2–5 bodies."** Not quite, and I did not write it that way.
   Measured (`grep -c keyLeakProblems`): tier2-dispatch-engine 2, tier2-fanout-bestofn 2, all five tier3
   files 2–3, tier4-resident 2, tier5-gate-steering 2 — **but `tier2-image-contract` has ZERO**, and it
   mints directly (3 `mintCappedKey`/`mintRunKey` hits). Two tier-1 files also mint with no verdict
   (`tier1-approval-gate` 4, `tier1-teardown` 3). Note the discriminator is *not* "mints in the test
   body": tier3/tier5 mint 0 directly and still need the verdict, because the `fleet dispatch`
   subprocess mints. So SKILL.md enumerates the covered files, dates the gap, and gives
   `grep -l keyLeakProblems tests/fleet/e2e/*.live.test.ts` as the durable roster — fail-safe: an
   operator who reads it will over-verify a covered file, never under-verify an uncovered one, and the
   sentence stays true when the parallel tier-1 fixer lands.
2. **"`teardownQuietly`'s label now spreads BEFORE `phase`"** — confirmed at `live-harness.ts:638,643`
   (`{ ...label, phase: "finally-teardown", ok, … }`), both arms record `ok`. Held.
3. **The `binary-licenses.json` "diff is BY PATH" claim** — confirmed stale; the build-script fixer's
   report was right on both counts. Also confirmed the second half of his note: it is the *coverage*
   that is basename-based and now optionally path-scoped, not the diff.

## Gate output

### 1. JSON parse
```
$ python3 -c "import json; json.load(open('oci/exedev/binary-licenses.json')); print('json ok')"
json ok
```

### 2. `validateBinaryLicenses` over the real file
```
$ bun -e '
import { validateBinaryLicenses } from "./scripts/build-exedev-image.ts";
const raw = JSON.parse(await Bun.file("oci/exedev/binary-licenses.json").text());
console.log("problems =", JSON.stringify(validateBinaryLicenses(raw, "oci/license-texts")));
'
problems = []
```

### 3. `bun test tests/scripts/`
```
 448 pass
 2 skip
 0 fail
 1119 expect() calls
Ran 450 tests across 14 files. [35.39s]
```
(the preceding lines are the cost-ledger migration `note:`/`warning:` chatter these suites assert on,
not failures)

### 4. biome + tsc
```
$ bunx biome check scripts/build-exedev-image.ts
Checked 1 file in 325ms. No fixes applied.
=== biome exit=0 ===
```
```
$ bunx tsc --noEmit
tests/providers/exedev/image-assets.test.ts(396,10): error TS6133: 'tmpfilesViolations' is declared but its value is never read.
```
ONE error repo-wide, in a file I did not touch and do not own (`tests/providers/` — another fixer's,
an unused local left by an in-flight edit). Zero errors in `scripts/build-exedev-image.ts`,
`tests/fleet/e2e/live-harness.ts`, or anything else in my scope. `.md` and `.json` are outside tsc.

### 5. Remaining `tier1-image-contract`
```
$ grep -rn "tier1-image-contract" . --include='*.ts' --include='*.md' --include='*.yml' | grep -v _bmad-output
.claude/skills/qds-live-e2e/SKILL.md:95:`tier1-image-contract` was RENAMED to `tier2-image-contract` on 2026-09-01 for
```
The single hit is the intentional historical sentence documented above.

No commits, no staging, no push.
