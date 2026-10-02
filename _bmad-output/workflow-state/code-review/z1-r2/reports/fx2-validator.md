# fx2-validator — R2 fix report (scripts/swarmclaw-fork-pin.ts)

Round z1-r2, branch feature/z1-adapter-contract-v2. Only file touched: `scripts/swarmclaw-fork-pin.ts`.

## Verdict table

| Finding | Label | Verdict | How |
|---|---|---|---|
| R2-01 | HIGH | FIXED | Post-pin rows now require `rev` to be a string equal to the pin. Missing/non-string rev → malformed-row failure naming "the post-pin expected value is the pin" (F-007 class). String rev ≠ pin → `post-pin manifest row for <rel> records rev <rev> but the pin is <pin> — the manifest is the record`. The per-stamp check still runs with expected=pin (conservative: evidence drift is never masked by the manifest failure). |
| R2-03 | MED | FIXED | `isRealInstant` helper: parse → `toISOString().replace(/\.000Z$/, "Z") === input`. Applied to the pinnedAt entry gate and citing.timestamp. NOTE: the finding's literal `new Date(parsed).toISOString() === input` would reject every valid seconds-precision ISO-Z stamp (toISOString always emits `.000`), so the roundtrip strips the `.000` this format forbids. New citing message names the value: `citing.timestamp "<v>" is not a real instant for <rel> (F-004)`. |
| R2-05 | MED | FIXED | `stampedDirs.length > 1` → early-return failure `multi-dir stampedDirs need dir-qualified manifest row keys — extend the manifest format deliberately (Z3)`. No half-support. |
| R2-16 | LOW | FIXED | `manifest === null || typeof !== "object"` → `fork-rev manifest malformed at <path>: not a JSON object — no row can be validated`. No TypeError. |
| R2-17 | LOW | FIXED | Empty → `no stamped dirs — the alarm would pass vacuously`. Duplicates → `duplicate stamped dir <dir> — it would be validated twice` (checked BEFORE the multi-dir gate so a duplicated pair gets the specific message, not Z3). |
| R2-18 | LOW | FIXED | statSync separated: missing → existing throw (unchanged message); exists but not a directory → throw `evidence dir <path> is not a directory`. |
| R2-19 | LOW | FIXED | Manifest exclusion is now `path.resolve(walked path) === path.resolve(manifestPath)`, at any walk depth. A top-level file named `fork-rev-manifest.json` that is not the manifest is evidence (unparseable decoy now fails loud per F-001; unstamped parseable decoy is ignored). `MANIFEST_FILENAME` const removed (dead). |
| R2-20 | LOW | FIXED | `entry.isSymbolicLink()` → `symlinked evidence path <dir>/<rel> is not walked — flatten the corpus`; never followed (loop risk). |
| R2-21 | LOW | FIXED | `missingDirs` set; the ghost check runs only when no stamped dir is missing → the missing-dir failure is the single root-cause line (verified: 2 ghost rows + missing dir = exactly 1 failure). |

## Verification (focal only, per constraints)

- `bun build --no-bundle scripts/swarmclaw-fork-pin.ts` — OK.
- Real corpus over `_bmad-output/evidence` with the four exported constants → `{ok:true}` (unchanged; all 37 manifest rows are pre-pin, so R2-01 does not touch them).
- Negative-path smoke (throwaway /tmp script, since fixture tests belong to wave B): 15/15 green covering every finding above plus the fixture-baseline green path.

## Behavior changes wave B must absorb (tests/fleet/swarmclaw-fork-pin.test.ts)

1. Impossible-but-parseable `pinnedAt` (e.g. `2026-02-30T00:00:00Z`) now fails the entry gate (roundtrip), not just NaN garbage.
2. Impossible `citing.timestamp` failure message changed to name the value: `citing.timestamp "<v>" is not a real instant for <rel> (F-004)` (old: `citing.timestamp not a real instant for <rel> (F-004)`).
3. Empty `stampedDirs` → failure (was vacuous green).
4. Duplicate `stampedDirs` entries → failure naming the repeated dir.
5. `stampedDirs.length > 1` → the Z3 early-return failure. Gate order is now: pinnedAt → stampedDirs gates → evidenceDir stat → manifest read, so a multi-dir + missing-evidence-dir invocation gets the Z3 line, not the throw.
6. Manifest JSON `null`/non-object → structured malformed-manifest failure (was uncaught TypeError).
7. `evidenceDir` present as a regular file → throw `evidence dir <path> is not a directory` (was swallowed into the missing-dir message).
8. Top-level same-named `fork-rev-manifest.json` decoys are no longer excluded by name — a fixture relying on name-based exclusion of a non-manifest decoy will see it walked as evidence.
9. Any symlinked entry inside a stamped dir → the symlink failure line (a fixture dir containing symlinks now fails).
10. Post-pin rows: missing/typed-wrong `rev` → malformed-row (F-007) failure; `rev !== pin` → the R2-01 manifest failure; drift check still runs against the pin, so one file can carry both failures.
11. Missing stamped dir + N rows under it → exactly 1 failure (was 1 + N ghost failures).

Exports, function signatures, and opts are unchanged; module stays pure fs-read (`node:fs`/`node:path` only, no side effects, no new imports).
