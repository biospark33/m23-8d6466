# fx2-alarm — R2 fix report (tests/fleet/swarmclaw-fork-pin.test.ts)

Round z1-r2, branch feature/z1-adapter-contract-v2. Only file touched: `tests/fleet/swarmclaw-fork-pin.test.ts`.

## Verdict table — the 11 fx2-validator behavior changes

| # | Change (fx2-validator report) | Pinned by |
|---|---|---|
| 1 | Impossible-but-parseable `pinnedAt` (`2026-02-30T00:00:00Z`, Date.parse rollover to Mar 2) now fails the entry gate | Added to the existing pinnedAt rejection loop — 3 shapes now covered (non-timestamp, out-of-range NaN, rollover); each asserts exactly 1 failure naming the value |
| 2 | Impossible `citing.timestamp` message now names the value | "shape-valid impossible citing.timestamp fails the F-004 branch naming the value (R2-15)" — asserts `toEqual` on the exact line `citing.timestamp "2026-02-30T12:00:00Z" is not a real instant for openrig-sc2/<name> (F-004)`, exactly 1 failure (evidence stamped with the pin itself so the branch is the row's) |
| 3 | Empty `stampedDirs` → failure (was vacuous green) | "empty stampedDirs fails instead of passing vacuously" — exact-message `toEqual` |
| 4 | Duplicate `stampedDirs` → failure naming the repeated dir | "duplicate stampedDirs entries fail naming the repeated dir — the specific gate, not Z3" — `["openrig-sc2","openrig-sc2"]` asserts the duplicate message, not Z3 |
| 5 | Multi-dir `stampedDirs` → Z3 early return; gate order pinnedAt → stampedDirs → evidenceDir stat → manifest read | "multi-dir stampedDirs hit the Z3 gate before the evidenceDir stat — one line, no throw" — absent evidenceDir + 2 dirs asserts exact Z3 line and NO throw |
| 6 | Manifest `null`/non-object → structured malformed failure (was TypeError) | "manifest whose root JSON is null or a bare string fails structured, not TypeError" — `null` and `"just a string"` both assert exact one-line message |
| 7 | `evidenceDir` present as a regular file → throw `evidence dir <path> is not a directory` | "an evidenceDir that is a regular file THROWS — ENOTDIR must not read as a missing corpus" — `toThrow` on the exact message |
| 8 | Same-named manifest decoys walked (exclusion by resolved path, not name) | New fixture "a same-named decoy file inside the stamped dir is walked as evidence" — unparseable top-level decoy asserts exact F-001 line, exactly 1 failure (proves it did not shadow the walk); the old subdir-decoy test retitled to state resolved-path semantics |
| 9 | Symlinked evidence entry → loud failure, never followed | "a symlinked entry inside a stamped dir fails loud and is never followed" — dangling symlink asserts exact `symlinked evidence path openrig-sc2/link.json is not walked — flatten the corpus`, exactly 1 failure |
| 10 | Post-pin row rev rules: missing/non-string rev → F-007 malformed; `rev !== pin` → manifest-record failure; drift still vs pin (both failures possible) | Three fixtures: (a) post-pin rev-less row → 1 failure naming "post-pin expected value is the pin"; (b) post-pin `rev: ROW_REV` with pin-stamped evidence → exactly the manifest-record line (drift provably green); (c) wrong rev + drifted evidence → exactly 2 failures, drift line carrying `expected=<PIN>` |
| 11 | Missing stamped dir + N rows under it → exactly 1 failure | "a missing stamped dir with N rows under it is exactly ONE failure" — 2 rows under the absent dir, asserts 1 failure and zero "no evidence file" lines |

## Triage items

- **R2-15** — covered by fixture #2 above (the F-004 branch itself, not the pinnedAt entry gate).
- **R2-12** — `stripComments` (string/template-aware; block comments collapse to one space) applied to the harness source BEFORE body extraction and stamp-literal matching. Verified separately (throwaway /tmp eval): a commented-out `swarmclawForkRev: SWARMCLAW_FORK_REV` (both `//` and `/* */`) vanishes from the stripped body while string URLs (`https://…`) and the `/[:.]/g` regex literal pass through intact.
- **R2-13** — same lint now asserts four contract needles in the comment-stripped `writeEvidence` body: plain-object guard, `"swarmclawForkRev" in payload` caller-stamp guard, `hasSwarmclawForkRevDeep(payload)` nested-stamp deep guard, `flag: "wx"` exclusive write. Missing ones fail with the guard names listed.
- **R2-11** — the real-manifest authorship test validates EVERY row's `citing.timestamp` (ISO-Z shape + the identical roundtrip rule, mirrored as a local helper) BEFORE the newest-row reduce; a malformed one throws naming the row's file and the bad value.

## Pre-existing fixtures corrected (forced by change #10)

- "a post-pin stamped rev that drifted from the pin": fixture row was post-pin with `rev: ROW_REV` — under R2-01 that is now an incoherent row. Fixture now records `rev: PIN` so the evidence drift is the sole failure (the test's own subject).
- "a row stamped exactly at the pin instant": name said "rev equals the pin" but the fixture set `ROW_REV` (harmless pre-R2-01). Now `rev: PIN` as named.

## Verification

`bun test tests/fleet/swarmclaw-fork-pin.test.ts` → **39 pass / 0 fail** (131 expect calls, 46 ms). Fixtures all in mkdtemp tmp dirs with afterEach cleanup; zero writes into `_bmad-output`; imports unchanged in kind (pin module + bun:test + node builtins — `symlinkSync` added to the existing node:fs import).
