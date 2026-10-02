# Blind Hunter — R3 final confirmation sweep (z1-r3.diff)

Diff-only review (strict blindness). Target: full branch delta after r1 (22 patches) + r2 (19 patches).
Scope: NEW defects introduced by the r2 fixes, or material defects both rounds missed.

**Verdict: not clean — 5 findings (1 HIGH, 2 MEDIUM, 2 LOW).** The validator/harness hardening itself
is internally coherent (gate order matches the pinned test, boundary math is ISO-Z-correct, meta
coherence is enforced both directions); the defects are in what the branch *ships* vs what it
*assumes on disk*, and in two recursive scans that claim to mirror each other but don't.

---

## B3-1 (HIGH) — Committed manifest indexes evidence files the branch does not carry; live green test ghosts on any clean checkout

- The branch adds `_bmad-output/evidence/openrig-sc2/fork-rev-manifest.json` (36 rows), but the diff
  adds **none** of the evidence JSONs those rows name. The newest rows (the five
  `2026-09-30T15-19/15-20-*` sc2-7 rounds) are untracked (`??`) in the working tree while the
  manifest itself is staged (`A`).
- `tests/fleet/swarmclaw-fork-pin.test.ts` runs the alarm over the **real** corpus and asserts
  `expect(result).toEqual({ ok: true })`. The validator's ghost check requires every manifest row's
  file to be walked: on any checkout where the evidence JSONs are absent, every such row fires
  `manifest row X has no evidence file (F-009)` and the "real corpus validates green" test goes red.
  The alarm's only product is claimed to be truth; as shipped, its truth depends on files git does
  not carry. Either commit the evidence JSONs in the same change, or the alarm is green only on
  machines that happen to hold the untracked files.

## B3-2 (MEDIUM) — Harness guard depth cap (10) vs alarm finder (unbounded): the "mirroring" claim is false, and the gap is exactly the laundering path the guard exists to close

- `sc2-harness.ts` `hasSwarmclawForkRevDeep` stops at `depth >= 10` ("cap guards cyclic payloads").
  The alarm's `findStampedRevs` in `scripts/swarmclaw-fork-pin.ts` is fully recursive with no cap.
- A caller-supplied `swarmclawForkRev` nested ≥ 11 levels deep passes the writer's guard, gets the
  writer's stamp added, lands on disk — and the alarm's unbounded finder then finds the injected
  stamp and false-fires drift/unmapped. That is precisely the caller-supplied-stamp laundering the
  guard's error message says it prevents. The guard must either use the same recursion shape as the
  finder (no cap — JSON payloads from `JSON.parse` can't be cyclic, so the cap is protecting against
  a shape that can't reach the finder) or the finder must carry the identical cap. As written, two
  scans with different termination rules are documented as mirrors.
- Same-family asymmetry, safe direction: the guard uses `in` (prototype chain), the finder uses
  `Object.entries` (own enumerable) — guard is stricter, so this half can only over-throw, never
  under-detect. Only the depth gap is dangerous.

## B3-3 (MEDIUM) — q1 observe status tests assert an empty fleet from a store the same helper's result branch has just populated

- `assertObserveSurface`'s status branch asserts `expect(empty.lines).toHaveLength(0)` on
  `["status", "--driver", "fake"]` — i.e. the fleet lists **zero** rows — and then a few lines later
  proves that a bare `deps.store.create("qds-20260928-obsv02")` makes `listed.lines.length > 0`.
  Bare open store records ARE the rows.
- All four new q1 observe tests share one `store` (captured in `observeDeps()` from outer scope in
  `q1-contract.test.ts`), and tests 1–2 (result branch) run first, calling
  `deps.store.create("qds-20260928-obsv01")` on that same store — twice (test 2 re-runs the
  identical invocation, re-creating the same runId; this also assumes `store.create` is idempotent,
  which the diff cannot show). If `fleet status` lists open records — which the status branch's own
  final assertion establishes — tests 3 and 4's empty-fleet probes cannot be empty. Unless a
  per-test `store` reset exists outside the diff, the four tests are order-dependent and at most
  one branch-pair can pass per store state. The helper should own its store lifecycle or assert
  "no rows for records other than the ones this invocation created", not global emptiness.
- Related overclaim: tests 1≡2 and 3≡4 have byte-identical bodies; the suite advertises four
  observe tests but contains two invocations, each run twice under different titles.

## B3-4 (LOW) — `walkJsons` nested-directory `readdirSync` is uncaught: a permission-denied subdirectory throws out of `validateEvidenceForkRevs`, breaking its documented return contract

- The top-level stamped-dir `readdirSync` is guarded (missing dir → `ok:false` failure entry), and
  unreadable *files* inside the walk are caught and pushed as F-001 failures. But the recursive
  `walkJsons(full, ...)` call does not guard its own `readdirSync`: an EACCES/EIO subdirectory
  propagates a raw throw out of the alarm, violating the `{ ok: true } | { ok: false; failures }`
  shape the suite pins everywhere else. Only the evidenceDir stat throws are documented as
  deliberate ("misconfigured invocation"); a mid-corpus unreadable directory is a corpus condition
  and per the module's own doctrine ("the alarm fails loud on anything it cannot verify") should be
  a failure entry, not an exception type the caller doesn't expect.

## B3-5 (LOW) — Test 4's title promises "result driver-free" but its body only exercises the status branch

- `q1-contract.test.ts` test 4 is titled "…result driver-free and status's --driver owned by the
  deployed wrapper…" but invokes `assertObserveSurface(..., { verb: "status" })`. The result row's
  missing `--driver` flag — the only assertion in the helper that evidences "result driver-free" —
  lives in the result branch and never runs in this test. The claim is true of the *suite* (test 1
  runs the result branch), but this test's name overclaims its own body. Same pattern as B3-3's
  duplicated invocations: distinct titles over identical bodies.

---

Not flagged (checked and clean): pinnedAt/citing boundary math (shape + real-instant roundtrip both
run before the string compare, so `>=` is chronologically sound; inclusive-at-pin matches manifest
`boundaryRule` and DD-29 prose); manifest meta pinRev/pinnedAt vs exports (byte-identical);
gate order pinnedAt → stampedDirs → evidenceDir stat → manifest read (matches the r2 gate-order
test); ghost suppression under a missing dir (1+N) and its exclusion of duplicates; R2-11
timestamp validation before the newest-row reduce; stripComments string/escape/block handling vs
the harness's only regex; `flag: "wx"` EEXIST path; stamp-before-scrub ordering (scrub gates the
exact bytes written); STATUS_VOCABULARY count (16, matches its own length pin); the writer's
caller-stamp guards vs the finder's own-key extraction (safe direction, see B3-2).
