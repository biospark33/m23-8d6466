# fx-validator — z1-r1 fix report

File: `scripts/swarmclaw-fork-pin.ts` (only file touched). All 13 PATCH findings applied.

## Verdict table

| Finding | Fix | Location |
|---|---|---|
| F-001 HIGH | `walkJsons` parse failure pushes `unreadable evidence file <dir>/<rel> — cannot confirm it is unstamped; the alarm never skips silently`; failures threaded via a `failures` param; unparseable files yield no entry | walkJsons, scripts/swarmclaw-fork-pin.ts:250-255 |
| F-003 LOW | `pinnedAt` validated at entry: ISO_Z shape + `Date.parse` non-NaN; single failure naming the offending value, immediate return | scripts/swarmclaw-fork-pin.ts:62-70 |
| F-004 LOW | after ISO_Z passes, `citing.timestamp` gets a `Date.parse` NaN check → `citing.timestamp not a real instant for <rel>` | scripts/swarmclaw-fork-pin.ts:157-159 |
| F-005 LOW | manifest parses but `rounds` missing/non-array → `manifest rounds missing or not an array at <path>`, immediate return (no silent `[]`) | scripts/swarmclaw-fork-pin.ts:87-92 |
| F-006 LOW | unreadable manifest → one failure, immediate `{ok:false, failures}` return (no N+1 spam) | scripts/swarmclaw-fork-pin.ts:76-85 |
| F-007 LOW | pre-pin row with non-string `rev` → `malformed manifest row for <rel>: rev missing — the pre-pin expected value is its row's rev`, before comparison; post-pin rows don't require rev | scripts/swarmclaw-fork-pin.ts:161-166 |
| F-008 LOW | duplicate rows for the same file key → `duplicate manifest rows for <file> at indexes <i, j> — contradictory provenance is never resolved silently` | scripts/swarmclaw-fork-pin.ts:171-175 |
| F-009 MED | rows→files check: a row whose file exists in no walked stamped dir → `manifest row <file> has no evidence file` (multi-dir safe: fires only if the file is absent from ALL stamped dirs) | scripts/swarmclaw-fork-pin.ts:176-178 |
| F-010 MED | `walkJsons` returns subdir-relative forward-slash paths; row matching is exact-key on that path only (bare-name disjunct dropped); comment now states subdirs are supported, rows keyed by subdir-relative path | scripts/swarmclaw-fork-pin.ts:140, 181-184, 229-238 |
| F-011 MED | `evidenceDir` absent/not a dir → `throw` (misconfigured invocation); missing stamped subdir while evidenceDir exists → failure line, continue | scripts/swarmclaw-fork-pin.ts:73-82, 187-194 |
| F-013 MED (validator half) | `manifest.meta` required; `meta.pinRev === pin` and `meta.pinnedAt === pinnedAt` enforced with failures naming both values; meta missing → `manifest meta missing — pinRev/pinnedAt coherence is part of the record` | scripts/swarmclaw-fork-pin.ts:94-113 |
| F-020 LOW | extension check case-insensitive (`.JSON` walked); `fork-rev-manifest.json` excluded only at the stamped dir's top level (`relPrefix === ""`) — same-named subdir file is evidence | scripts/swarmclaw-fork-pin.ts:241-243 |
| F-021 LOW | non-string value under `swarmclawForkRev` counted per key → `stamp at <rel> is not a string — structured stamp shapes are not part of the contract`; not recursed for extraction | scripts/swarmclaw-fork-pin.ts:143-147, 260-290 |

## Extra behavior change (not finding-mandated, needed for well-defined keys)

A manifest row that is not an object, or whose `file` is not a string, now fails (`malformed manifest row at index <n>: ...`) and is excluded from the row map. Without it, F-008/F-009 map keys would be `undefined`/garbage.

## Intentional behavior changes — for the wave-2 test fixer (tests/fleet/swarmclaw-fork-pin.test.ts)

1. **Unreadable evidence JSON fails** (was silent skip → vacuous ok). Fixtures staging corrupt JSON must now expect a failure.
2. **Bad `pinnedAt`** (non-ISO-Z or impossible instant) → immediate single failure naming the value (was lexicographic compare on garbage).
3. **Unreadable manifest** → immediate return, exactly ONE failure (was 1 + N coverage spam).
4. **`rounds` missing or non-array** → immediate return, ONE failure (was silent `[]`).
5. **`meta` is required and coherence-checked**: every fixture manifest needs `meta.pinRev === pin` and `meta.pinnedAt === pinnedAt`, or expect failures. `meta` absent → failure.
6. **Pre-pin row missing `rev`** → malformed-row failure (was `expected=undefined` compare).
7. **Duplicate rows** for the same file → failure naming file + indexes (was silent first-row-wins).
8. **Row naming an absent file** → `manifest row <file> has no evidence file` failure (new direction).
9. **Missing stamped subdir** → failure line (was silent continue). **Missing `evidenceDir`** now THROWS — fixtures must never pass an absent evidenceDir.
10. **Row matching is exact subdir-relative path** (forward slashes, walk-produced). Bare-name rows still match flat files (real corpus unchanged), but fixture rows must use the walk-relative key; `${dir}/x.json`-prefixed or basename+dir triple-disjunct matching is gone.
11. **Uppercase `.JSON` files are walked**; manifest exclusion is top-level-of-stamped-dir only.
12. **Non-string `swarmclawForkRev`** → failure (was silently uncollected).

Exports, signatures, and the opts shape are unchanged; module remains pure-fs-read, `node:fs`/`node:path` only, no load-time side effects.

## Impact analysis

`mcp__gitnexus__impact` on `validateEvidenceForkRevs` (repo QDS-Factory) returned **target not found** — the symbol is on the unindexed `feature/z1-adapter-contract-v2` branch (file is new, `A` in git status). Blast radius established by grep instead: the ONLY caller is `tests/fleet/swarmclaw-fork-pin.test.ts` (the wave-2 fixer's file); `scripts/swarmclaw-fork-pin.ts` itself exports the constants; nothing else imports the module. Risk: contained — all breakage lands in the file already owned by the wave-2 test fixer.

## Verification

- Focal check: `bun -e` import → `typeof validateEvidenceForkRevs === "function"`; constants intact.
- `bun build --no-bundle scripts/swarmclaw-fork-pin.ts` → OK.
- Real corpus smoke: validator over `_bmad-output/evidence` with the exported pin/pinnedAt → `{ok:true}` (meta coherence + relative-path matching produce no false positives across the 36 real rows).
- Negative smokes (tmp fixtures): bad pinnedAt, missing stamped dir, missing evidenceDir (throws), unreadable evidence file, impossible citing instant, pre-pin missing rev, non-string stamp, duplicate rows, ghost row, meta mismatches, subdir same-named manifest as evidence — all fire exactly one actionable line each; subdir matching case `{ok:true}`.
- No test suite run (per instructions).
