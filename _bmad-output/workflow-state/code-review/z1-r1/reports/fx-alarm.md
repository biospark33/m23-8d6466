# fx-alarm — z1-r1 fix report

File: `tests/fleet/swarmclaw-fork-pin.test.ts` (only file touched). Suite re-pinned to the hardened validator; every fixture test from the z1 pre-hardening suite retained and updated, plus 14 new tests.

## Final count

`bun test tests/fleet/swarmclaw-fork-pin.test.ts` → **27 pass / 0 fail** (91 expect calls, 35 ms). Nothing else run.

## Per-finding verdict

| Finding | Verdict |
|---|---|
| F-001 HIGH | Re-pinned: corrupt-JSON fixture (`{not json`) → exactly 1 failure `unreadable evidence file openrig-sc2/corrupt-evidence.json … never skips silently`. Silent-skip regression now breaks the suite. |
| F-003 LOW | Re-pinned: `validateEvidenceForkRevs` called directly with `not-a-timestamp` AND shape-valid-but-impossible `2026-13-45T99:99:99Z` → each exactly 1 failure naming the value (covers both the ISO-Z shape branch and the `Date.parse` NaN branch). |
| F-004 LOW | Covered by the F-003 impossible-instant case plus every fixture row's `Date.parse`-checked path; no separate fixture needed beyond F-003's. |
| F-005 LOW | Re-pinned: `rounds: "not-an-array"` → exactly 1 failure `rounds missing or not an array`. |
| F-006 LOW | Re-pinned: unreadable manifest → `toHaveLength(1)`, names the manifest path; the old N+1 coverage spam would fail the count. |
| F-007 LOW | Re-pinned: pre-pin row without `rev` → 1 failure `malformed manifest row for openrig-sc2/<name> … rev missing`; suite also asserts the joined report never contains `expected=undefined`. |
| F-008 LOW | Re-pinned: duplicated row (same object twice) → 1 failure naming file + `indexes 0, 1`. Rows are otherwise drift-clean so the duplicate is the ONLY failure. |
| F-009 MED | Re-pinned both directions: ghost row (`ghost.json`, empty stamped dir) → exact line `manifest row ghost.json has no evidence file (F-009)`; the existing real-corpus green test keeps files→rows coverage honest. |
| F-010 MED | Re-pinned: same basename `result.json` in `r1/` and `r2/` with different stamps (one post-pin, one pre-pin) → ok:true only under exact subdir-relative matching; basename collision would produce unmapped+ghost failures. |
| F-011 MED | Both halves pinned: missing stamped subdir under existing evidenceDir → exactly 1 failure `stamped dir openrig-sc2 missing`; absent evidenceDir → `expect(…).toThrow(/evidence dir .*does not exist/)`. No fixture passes an absent evidenceDir expecting success. |
| F-012 HIGH | Negative control added: source-lint test reads `tests/fleet/e2e/sc2-harness.ts`, asserts it imports `scripts/swarmclaw-fork-pin`, slices the `writeEvidence` body (to the next `\nexport `), and throws the mandated message `sc2-harness writeEvidence no longer stamps swarmclawForkRev — AC7's alarm arming is broken` if the `swarmclawForkRev: SWARMCLAW_FORK_REV` assignment is gone. |
| F-013 MED (test half) | (a) Real-manifest assertion: newest round row (max `citing.timestamp`, via reduce — no order assumption) `rev === SWARMCLAW_FORK_REV`; `meta.pinRev === PIN`, `meta.pinnedAt === SWARMCLAW_FORK_REV_PINNED_AT`. (b) Validator-half coherence pinned with 3 fixtures: meta missing → `manifest meta missing`; `meta.pinRev` wrong → failure naming both revs; `meta.pinnedAt` wrong → failure naming both instants. (c) Every fixture manifest defaults to coherent meta via the `withMeta` helper, so no fixture pollutes unrelated failure counts. |
| F-018 LOW | Authorship test: `[...STAMPED_EVIDENCE_DIRS]` `toEqual(["openrig-sc2"])` — reorder retargeting fixtures now fails loud. |
| F-019 MED | Production-layout drift fixture: manifest written INSIDE the stamped dir (`evidence/openrig-sc2/fork-rev-manifest.json`, exact real-corpus shape), evidence stamped `WRONG_REV`, row keyed stamped-dir-relative → exactly 1 failure `fork-rev drift in openrig-sc2/<name> … evidence=WRONG_REV expected=PIN`. Proves top-level manifest exclusion + relative keys + drift through the production invocation shape. |
| F-020 LOW | Combined fixture: `STAMPED.JSON` (uppercase, walked — else its row goes ghost) green, plus SUBDIR `rounds/fork-rev-manifest.json` carrying a wrong stamp (evidence, not excluded) → exactly 1 failure proves both directions at once. |
| F-021 LOW | Re-pinned: `{swarmclawForkRev: 42}` → exactly 1 failure `stamp at openrig-sc2/<name> is not a string`. |

Retained pre-existing tests (real-corpus green, post-pin drift, pre-pin drift, legitimate pre-pin pass, unmapped-file coverage finding, boundary-inclusive pass, self-claim-cannot-save, unstamped-ignored) all pass unchanged against the hardened validator — only fixture manifests gained coherent meta.

## Validator behaviors that surprised fx-alarm

1. **The pinnedAt gate runs before everything** — including the evidenceDir stat — so the bad-pinnedAt test never touches the fixture corpus. Also means the "no fixture may pass an absent evidenceDir" rule is trivially satisfiable there.
2. **Non-string stamps need no row**: the failure is pushed before the `stamps.length === 0` continue, so `{swarmclawForkRev: 42}` fires with an empty rounds array. Fixture staged accordingly.
3. **Top-level manifest exclusion is unobservable in the green direction** — the manifest carries no `swarmclawForkRev`, so if exclusion broke it would walk as unstamped evidence and stay silent. The only observable direction is the reverse (subdir manifest-named file IS evidence), which the F-020 fixture pins.
4. **Pre-pin `rev` is required only when a stamped file maps to the row** — a rev-less row on an unstamped file is fine, so the F-007 fixture must actually stamp the file to reach the malformed-row branch.

## Boundary

Imports only the pin module + `bun:test` + `node:fs`/`node:os`/`node:path`. All fixtures in mkdtemp dirs under `os.tmpdir()`, `afterEach` recursive cleanup; the only `_bmad-output` touch is READS (real manifest, harness source). No writes into `_bmad-output`.
