# Blind Hunter findings — z1-r1.diff

- **Shared `store` + duplicate `store.create` of identical runIds across the four q1 tests — order-dependent and possibly throwing. HIGH.**
  Evidence: `q1-contract.test.ts` defines `observeDeps = () => ({ ..., store, ... })` capturing one outer-scope `store`; test 1 and test 2 both run `assertObserveSurface(..., { verb: "result" })`, which executes `deps.store.create("qds-20260928-obsv01")` twice on that store; tests 3 and 4 both run the status branch, which executes `deps.store.create("qds-20260928-obsv02")` twice. The status branch's own "One open record over no box" probe proves store-only records produce stdout rows, yet the empty-fleet probe asserts `expect(empty.lines).toHaveLength(0)` — which is only true if the result-branch tests did not pollute the same store. Either the tests are order-dependent/broken, or isolation lives entirely outside this diff and the test names ("exit 0 on an empty store") assert something the diff cannot guarantee. If `RunRecordStore.create` throws on duplicate id, tests 2 and 4 fail outright.

- **Corrupt stamped evidence JSON is silently skipped by the drift alarm — the alarm swallows exactly the files most likely to hide drift. HIGH.**
  Evidence: `walkJsons` catches JSON parse failure and pushes `{ file, parsed: undefined }`; `findStampedRevs(undefined)` returns `[]`, so the loop hits `if (stampedValues.length === 0) continue;`. A truncated/invalid evidence file (the normal artifact of a crash mid-write, or of tampering) gets zero alarm scrutiny, while the module docblock boasts "a missing bracket is never assumed" — that rigor is applied only to manifest rows, not to unreadable evidence. The manifest-unreadable path pushes a failure; the evidence-unreadable path passes silently. Inconsistent failure doctrine in the one module whose job is failing loudly.

- **`writeEvidence` spread corrupts non-object payloads and silently overwrites a caller-supplied stamp. MED.**
  Evidence: `payload = { ...(payload as Record<string, unknown>), swarmclawForkRev: SWARMCLAW_FORK_REV }` with signature `payload: unknown`. An array payload lands on disk as `{0:..., 1:..., swarmclawForkRev}` — the evidence shape silently changes from array to object; a string payload becomes a char-indexed object. The cast asserts a type the code does not guarantee. Additionally, if a payload already carries `swarmclawForkRev` (replayed old-round evidence), the stamp overwrites it: a replay of a pre-pin round is re-stamped with the current pin, which then mismatches its pre-pin manifest row (`expected=row.rev`) — a false drift alarm — or, if the row is updated, the original rev is laundered out of the record. The comment claims "the caller's payload stays unmutated" and says nothing about collision.

- **The alarm ships vacuous: zero stamped evidence files, admitted vacuous-true real-corpus test, unexercised production wiring. MED.**
  Evidence: the test itself comments "no evidence file carries a swarmclawForkRev stamp yet (AC7 arms later) — ok:true is the vacuous-true". The diff ships the manifest, the alarm, and the harness stamp, but no stamped file — so the production-shape path (manifest living *inside* the walked `openrig-sc2/` dir, basename row-mapping, `stampedDirs` matching) is never exercised; every fixture places the manifest *outside* `evidenceDir`, i.e. a different layout than production. The first real post-pin round is the first-ever execution of the real wiring, in CI.

- **Every future stamped evidence file fails CI until a hand-authored manifest row lands — alarm fatigue by design, no tooling shipped. MED.**
  Evidence: `writeEvidence` stamps unconditionally; `validateEvidenceForkRevs` pushes `unmapped evidence file ...: add its rev from round provenance — never guess` for any stamped file without a row. The diff provides no script to append rows, so the routine e2e workflow now reds CI until someone hand-edits a 40-line manifest JSON. An alarm that fires on every normal operation trains people to ignore it.

- **`walkJsons` keys by basename only — the "round subdirs allowed tomorrow" comment is contradicted by the mapping logic. MED.**
  Evidence: recursion descends into directories but records `file: entry.name` (basename). Two same-named files in different round subdirs map to the same manifest row (`rows.find` picks the first), and `rel = path.join(dir, entry.file)` mislabels nested files by dropping the subdir. The code comment "`**` walk: ... round subdirs are allowed tomorrow" promises a capability the row-matching cannot support.

- **Test name asserts a read-only closure the assertions cannot establish. MED.**
  Evidence: test 4's name claims "the read-only closure allows exactly status and result — the fork's only route is $SWARMCLAW_FACTORY_FLEET_CLI..."; the actual assertion is `verbs.filter(...).map(...).sort()` equals `["result","status"]` — i.e. merely that two registry entries exist. Nothing in the diff asserts the other 14 verbs are non-mutating or that any env-var route exists. The docblock honestly says "Every other verb ... is outside this contract", so the test name overclaims what was proven.

- **Tests 1/2 and 3/4 are identical invocations wearing different names. MED.**
  Evidence: test 1 and test 2 both call `assertObserveSurface(run, outLines, errLines, observeDeps(), { verb: "result" })`; tests 3 and 4 both call it with `{ verb: "status" }`. Each invocation runs the entire surface for that verb, so the exit-4 probe claimed by test 2's name runs in both tests, and the closure claim of test 4's name is "verified" by re-running the status branch. Misleading granularity, duplicated store mutations (see finding 1), doubled runtime.

- **Non-array `manifest.rounds` silently coerced to `[]` — "shape is asserted, never trusted" overstates. LOW.**
  Evidence: `rows = Array.isArray(manifest.rounds) ? manifest.rounds : [];` — a manifest with `"rounds": {}` yields the same behavior as no manifest at all: every stamped file reported as "unmapped evidence file" (a coverage verdict) instead of "manifest malformed" (a tooling verdict). The comment directly above claims assertion.

- **`pinnedAt` is never validated inside `validateEvidenceForkRevs`; mixed-precision ISO strings break the lexicographic boundary. LOW.**
  Evidence: the function tests `ISO_Z` against `citing` only; `pinnedAt` is trusted. `ISO_Z` forbids fractional seconds, but a future `pinnedAt` like `2026-10-02T15:08:06.500Z` compared against a row at `...:06Z`: `"06Z" >= "06.500Z"` is true (`Z` > `.`), so a row from the same second *before* the pin instant is classified post-pin. Only the test suite checks the exported constant's format; the exported function accepts anything.

- **Unreadable manifest produces failure spam with a misleading second diagnosis. LOW.**
  Evidence: on manifest read/parse failure, one "unreadable" failure is pushed, then the loop continues with `rows = []`, so every stamped file additionally reports "unmapped evidence file ... never guess" — one root cause surfaced as N+1 findings, half of them misattributed to missing provenance rather than a broken manifest.

- **Pre-pin manifest row missing `rev` yields `expected=undefined` in the alarm message. LOW.**
  Evidence: `row.rev` is optional in the shape (`rev?: string`) and pre-pin comparison uses `expected = row.rev` directly; a row with a valid timestamp but missing rev produces `fork-rev drift in X: evidence=<rev> expected=undefined (pre-pin manifest row)` — technically fails, but the report is garbage precisely where the module promises actionability ("the drift report must be actionable").

- **`findStampedRevs` skips an object-valued `swarmclawForkRev` key entirely. LOW.**
  Evidence: `if (key === "swarmclawForkRev" && typeof v === "string") out.push(v); else out.push(...findStampedRevs(v));` — a `swarmclawForkRev` whose value is an object is neither collected nor recursed, so a (contrived) nested stamp in object form escapes the alarm while a plain deeply-nested string stamp is caught.

- **Fixture binds `STAMPED_EVIDENCE_DIRS[0]` — reordering the export silently retargets every fixture. LOW.**
  Evidence: `const stampedDir = join(evidenceDir, STAMPED_EVIDENCE_DIRS[0]);` in `stageFixture`. The comment "evidence directories whose writer stamps (Z3 extends)" announces the array will grow; index-0 binding means a future reorder or prepend changes which directory all fixtures exercise, with no failure — just tests of the wrong thing.

- **Manifest `meta` vs exported pin agreement is test-only, not part of the alarm contract. LOW.**
  Evidence: `validateEvidenceForkRevs` never reads `manifest.meta`; the pinRev/pinnedAt equality check lives only in a test reading `REAL_MANIFEST_PATH`. A bump PR that updates the constant but forgets the manifest meta passes the alarm (all rows pre-pin) — the "manifest is the record" invariant is enforced by a test, not by the validator the workflow actually runs.

- **DD-29 prose and the import graph disagree about where this module may be consumed from. LOW.**
  Evidence: the spec text declares `scripts/swarmclaw-fork-pin.ts` lives "at `scripts/` root — **outside the box COPY set**", while `tests/fleet/e2e/sc2-harness.ts` imports it via `../../../scripts/swarmclaw-fork-pin.ts`. If any e2e harness execution context copies/consumes the test tree without `scripts/`, module resolution fails; at minimum, a module simultaneously load-bearing for live e2e and declared outside the deployed artifact set is a coupling the spec text does not acknowledge.
