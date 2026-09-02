# FIX-LIVE-T2345

All findings LOCATED and VERIFIED before patching. No false positives — every
finding held. Line numbers below are POST-patch unless marked "was".

## Patched

| ID | File:line | What changed | Why |
|----|-----------|--------------|-----|
| F2 | `tests/fleet/e2e/tier2-dispatch-engine.live.test.ts:337-350` (was :329) | `runFleet(["teardown"…])` → `teardownQuietly(…, { at: "teardown-verb", runId })`; non-ok → `destroyFailures` | `runFleet` REJECTS on its ceiling (`live-harness.ts:236`); the rejection escaped at the await and skipped `destroyQuietly` on the next line, the `final-ls` poll, the evidence write and `settleRun` |
| F2 | `tier2-fanout-bestofn.live.test.ts:294-309` (was :294) | same, label `{ at: "teardown-arm", arm: i, runId: id }` | AMPLIFIED: the call sits in a `for` over arms — arm 0's timeout skipped arm 1's teardown AND the whole `armVms` destroy loop below (2+ boxes from one clock) |
| F2 | `tier3-expose-port.live.test.ts:274-288` (was :265) | same, label `{ at: "teardown", runId: id }` | loop over `[neg, pos]` — leg 1's timeout skipped leg 2's teardown, the belt-and-braces sweep and the revoke pass |
| F2 | `tier3-manystories.live.test.ts:382-396` (was :381) | same, label `{ at: "teardown-arm", arm: i, runId: id }` | fanout arm loop, same amplification |
| F2 | `tier3-race.live.test.ts:441-456` (was :435) | same | fanout arm loop; in the degraded field arm 1 is the one whose key is LIVE by design (`:384`) |
| F2 | `tier3-reaper.live.test.ts:554-566` (was :526, T3.4b) | same, label `{ at: "teardown", runId }` | skipped the box destroy, the nameless-orphan sweep, the evidence write and `settleRun` |
| F2 | `tier4-resident.live.test.ts:547-559` (was :541) | same | the resident box is the most expensive box this suite creates |
| F5 | `tier5-gate-steering.live.test.ts:679-717` | Deleted `sweep`/`sweepError`/`t51BoxAbsence`. Now: destroy recovered `vmName` → destroy EVERY `e2e-`/`qds-` box the fleet lists → re-list with the 5×8 s lag poll into `finalBoxes` | The relative verdict was vacuous: one un-retried `list()` inside the measured 25 s+ lag returns `[]`, and `!names.some(n => [].includes(n))` is `true` for free. The absolute population is what every sibling tier judges, and `fleetCleanupProblems(…, undefined)` makes an UNMEASURED listing a problem rather than a pass. This is also the absolute `e2e-|qds-` backstop the file lacked |
| F6 | `tier5-gate-steering.live.test.ts:768-782` | The stack of bare `expect`s + `if (failure !== undefined) throw failure` → `settleRun(failure, problems)`, with box, key and `finally-revoke ok:false` verdicts all folded into `problems` | A failing cleanup `expect` threw its own AssertionError and the held body error at `:663` was never re-thrown — the operator reads "box absence" where the engine regression was |
| F10 | `live-harness.ts:648-664` | `ok` recorded on BOTH arms of `teardownQuietly` | Evidence auditing here uses `phase === X && ok === false` (e.g. T5.1's revoke filter); an entry carrying only a non-zero `exitCode` read as CLEAN in the exact filter written to find failures |
| F10 | `live-harness.test.ts:158-163` | Unit test now asserts `entry?.ok === false`, not only `exitCode !== 0` | the claim was unpinned |
| F15 | `live-harness.ts:659, 663` | `label` spreads FIRST: `{ ...label, phase: "finally-teardown", … }` | a caller passing `{ phase: … }` rewrote the discriminator every audit keys off. Call sites now distinguish through their own fields (`at`, `arm`, `runId`) — tier3-reaper's existing shape |
| F15 | `live-harness.test.ts:166-177` | New test: a label carrying `phase` can NEVER rewrite the entry's | the seam that would get used wrongly |
| F11 | `live-harness.ts:667-704` | New `writeEvidenceQuietly(tag, name, payload, problems)` — never throws; folds the failure into the caller's problems list and keeps it LOUD on stderr | `writeEvidence` throws (ENOSPC/EACCES, and the secret-scrub refusal at `:189`). Uncaught, it propagated out of the outer `finally` and made `settleRun` on the next line unreachable — the one condition that most needs the verdict machinery was the one that bypassed it |
| F11 | 10 sites: `tier2-dispatch-engine:393`, `tier2-fanout-bestofn:349`, `tier3-expose-port:361`, `tier3-manystories:429`, `tier3-race:488`, `tier3-reaper:429` + `:601`, `tier3-remote-phases:246`, `tier4-resident:585`, `tier5-gate-steering:750` | `try { writeEvidence(…); stderr } finally { rmSync }` → `writeEvidenceQuietly(…, destroyFailures); rmSync(…)` | the try/finally became dead structure once the body cannot throw; the rm and the forensics-keep branches are byte-identical otherwise |
| F11 | `live-harness.test.ts:180-196` | New test: a failed write is a problem entry that `settleRun` renders, and the returned path is `""` | pins that it is not a swallowed warning |
| F12 | `tier3-reaper.live.test.ts:275-292` | In-BODY attempt cleanup: kept the recording (`teardownQuietly` + a new `attempt-cleanup-imperfect` evidence entry), DROPPED the promotion to `destroyFailures` | it cleans residue from a deliberately SIGKILLed dispatch; a half-written record, run-lock contention with the corpse, or an already-torn-down run all exit non-zero and none is a defect of the thing under test. Promoting it failed a 1.5 M ms real-money run whose body passed and whose boxes were gone |
| F16 | `live-harness.ts:100-114` (module state), `:139-148` (`preflight` stamp), `:224-235` (`writeEvidence`) | The effective `{ ref, buildId, overriddenBy, isRepoPin }` is captured by `preflight` and stamped into EVERY evidence file as `image` | the override line was printed, never recorded — a round against `QDS_EXEDEV_IMAGE=<other>` produced evidence indistinguishable from a repo-pinned one |
| F17 | `live-harness.ts:735-806` | New `keyLeakProblems(before, { driver, store?, runIds, list? }, evidence)`: diff the population, REVOKE survivors via `revokeQuietly` first, then report — as problem strings, never as `expect` | seven of nine tiers had no key-hash delta; a teardown that destroys the box and exits 0 while skipping the revoke passed them all green |
| F17 | 11 test bodies (see roster below) | `const hashesBefore = await listedKeyHashes()` before the try; `keyProblems = await keyLeakProblems(…)` in the finally; `settleRun(failure, [...fleetCleanupProblems(…), ...keyProblems])` | folds into the existing verdict rather than reintroducing the F4/F6 bare-`expect` shape |
| F17 | `tier3-expose-port` / `tier3-reaper` | converged: the sweep's per-box `revokeQuietly` and T3.4b's happy-path `not.toContain` are no longer the only key discipline; both now also carry the population verdict | one idiom, not two |
| F17 | `live-harness.test.ts:198-260` | 3 new tests: all-revoked → clean; surviving hash → revoked-then-reported as a PROBLEM that `settleRun` throws on; unkillable hash → "STILL LIVE"; failed listing → "never a clean one" | the offline pin the coordinator asked for |
| — | `tier5-gate-steering.live.test.ts:723-736` | Added a `workspace !== ""` guard to the EB2 `revokeQuietly`'s store | `join("", "runs")` is the RELATIVE path `"runs"` — a run that died before `tmpWorkspace` returned pointed a `RunRecordStore` at a directory under the process cwd. Found while converting; fail-safe, one guard |

## False positives

| ID | Why it does not hold, with evidence |
|----|-------------------------------------|
| — | None. All ten findings (F2, F5, F6, F10, F11, F12, F15, F16, F17) reproduced exactly as described. F2's seven unguarded sites, F5's single un-retried `ctx.driver.list()` at the old `:688`, F6's `expect` stack at the old `:755-767`, F10's missing `ok` at the old `:592`, F11's catch-less `try/finally` at all nine named sites, F12's `destroyFailures.push` at the old `:271`, F15's post-`phase` label spread, and F16's absent evidence sink were all verified in the source before patching. |

## Exported harness signature changes (the tier1 fixer depends on these)

**No breaking signature change. Two additive exports and one semantic change.**

1. **`teardownQuietly` — SIGNATURE UNCHANGED, SEMANTICS CHANGED (read this):**
   - `label` now spreads **before** `phase`, so a label carrying `phase` no longer
     overrides the entry's discriminator. Any tier1 call passing `{ phase: … }`
     will silently stop renaming the entry — use `at`/`runId` instead.
   - Every arm now records `ok`. Evidence filters of the form
     `phase === "finally-teardown" && ok === false` now work (they silently
     matched nothing before).
2. **NEW export `writeEvidenceQuietly(tag, name, payload, problems)` → `string`.**
   Never throws; pushes `the evidence write FAILED: …` into `problems` and
   returns `""`. `tier1-image-contract` (now `tier2-image-contract`) already has
   a hand-rolled per-site catch for this — it can converge on the helper, but
   nothing breaks if it does not.
3. **NEW export `keyLeakProblems(before, { driver, store?, runIds, list? }, evidence)`
   → `Promise<string[]>`.** `list` is a documented UNIT-TEST-ONLY seam
   (`live-harness.test.ts`); no `*.live.test.ts` may pass it.
4. **`writeEvidence` now stamps an `image` key** into every evidence JSON
   (ref/buildId/overriddenBy/isRepoPin, from `preflight`). Additive; a payload
   with its own `image` key would shadow it — none does today.

## Gate output

### 1. `bunx tsc --noEmit`
```
tsc-exit=0
```
Clean, repo-wide. (First run surfaced three `TS6133: 'evidencePath' is declared
but its value is never read` in files I touched — `writeEvidenceQuietly` prints
the path itself, so the variable became write-only. Removed in all three;
re-run is clean. No pre-existing errors elsewhere either.)

### 2. `bunx biome check tests/fleet/e2e/`
```
Checked 21 files in 306ms. No fixes applied.
biome-exit=0
```

### 3. `bun test tests/fleet/e2e/live-harness.test.ts`
```
bun test v1.4.0 (34cbb9a40)
[finally-revoke] failed for e2e-missing-abc123: unreadable run record e2e-missing-abc123.json: ENOENT
[finally-destroy] DESTROY FAILED for e2e-leak-abc123: substrate unreachable — remediation: ssh exe.dev rm e2e-leak-abc123
[UNIT] EVIDENCE WRITE FAILED: Maximum call stack size exceeded.

 12 pass
 0 fail
 43 expect() calls
Ran 12 tests across 1 file. [551.00ms]
```
(7 pre-existing + 5 new. The three stderr lines are the primitives' deliberate
loud-remediation output under test, not failures.)

### 4. `bun test tests/fleet/e2e/` with `QDS_E2E_LIVE` UNSET
```
bun-exit=0
grep-exit=1          # tr/perl-stripped grep for "(fail)|^error" matched NOTHING

 12 pass
 24 todo
 0 fail
 43 expect() calls
Ran 36 tests across 20 files. [1.63s]
```
Run as `env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test …` so every live test
`todoIf`s out. **NO BOX WAS PROVISIONED and NO MONEY WAS SPENT**, proven two
ways: all 24 live tests report `todo` (their bodies never execute, so no
`preflight`, no `driver.create`, no `mintRunKey`), and no evidence file was
written — the newest file in `_bmad-output/evidence/df3-e2e/` is
`2026-09-01-234604-t1-registry-auth.json` at mtime **19:46**, hours before this
session's gate runs at **22:10**. The only substrate object touched anywhere was
the in-process `ExeDevDriver` with a command injected at its own `run` seam.
The 24 todos include the four `tier1-*` files the parallel fixer owns; nothing
failed there either.

### 5. F2 completeness — `grep -n 'runFleet(["teardown"' tests/fleet/e2e/*.live.test.ts`
```
tier1-provision-status.live.test.ts:78     ← NOT MINE (tier1 fixer)
tier1-approval-gate.live.test.ts:778       ← NOT MINE
tier1-harvest.live.test.ts:145             ← NOT MINE
tier1-harvest.live.test.ts:234             ← NOT MINE
tier1-teardown.live.test.ts:109            ← NOT MINE
tier1-teardown.live.test.ts:145            ← NOT MINE
tier2-dispatch-engine.live.test.ts:283
tier2-fanout-bestofn.live.test.ts:244
tier3-expose-port.live.test.ts:157
tier3-expose-port.live.test.ts:186
tier3-expose-port.live.test.ts:233
tier3-manystories.live.test.ts:334
tier3-remote-phases.live.test.ts:193
tier4-resident.live.test.ts:522
tier5-gate-steering.live.test.ts:440
```
**Every remaining hit in a file I own is in the TEST BODY, not a `finally`** —
each is the production teardown leg the test exists to exercise, where a
rejection SHOULD fail the test. Proven by line ordering against each file's
`} finally {`:

| File | body hit(s) | its `} finally {` |
|------|-------------|-------------------|
| tier2-dispatch-engine | 283 | 326 |
| tier2-fanout-bestofn | 244 | 284 |
| tier3-expose-port | 157, 186, 233 | 259 |
| tier3-manystories | 334 | 374 (probe test's finally is 161, above) |
| tier3-remote-phases | 193 | 207 |
| tier4-resident | 522 | 538 |
| tier5-gate-steering | 440 | 665 |
| tier3-race, tier3-reaper | *(none)* | — |

Every hit precedes its enclosing `finally`. Zero unguarded teardowns remain in
any `finally` in my nine files. The corresponding `teardownQuietly(` calls are
at tier2-dispatch-engine:344, tier2-fanout-bestofn:302, tier3-expose-port:280,
tier3-manystories:390, tier3-race:449, tier3-reaper:284/381/562,
tier3-remote-phases:215 — all inside their `finally`.

## Decisions taken

**F11 — shared harness helper, not per-site catches.** Nine (ten, with T5.1)
byte-identical sites is exactly the case where one guard in the shared callee is
a smaller diff than a guard in every caller, and a per-site `catch` is a thing a
tenth tier forgets. `writeEvidenceQuietly` takes the `problems` array the site
already has (`destroyFailures`), so the failure travels through the SAME
`settleRun` the box and key leaks do. The secret-scrub refusal stays loud: it is
written to stderr with an `EVIDENCE WRITE FAILED` prefix AND becomes a
run-failing problem — downgraded only from "replaces every other fact" to
"reported alongside them", never to a swallowed warning.

**F12 — drop the promotion, keep (and enrich) the recording.** Option A. The
"is this box still billing?" gate would be more code for a guarantee that is
already there three times over: the `destroyQuietly` two lines below (a real
box, still promoted), the nameless-orphan sweep in the `finally`, and the
absolute `final-ls` verdict. A non-zero exit now also lands its own
`attempt-cleanup-imperfect` evidence entry naming the error, so the forensics
are strictly better than before while the run-failing verdict is reserved for
things that are actually defects.

**F16 — `writeEvidence` stamps it, from module state set by `preflight`.** The
"cannot be forgotten" option, as asked. An `evidence` parameter on `preflight`
is a thing a future tier can decline to pass; a stamp inside the one function
every tier already calls is not. Pre-`preflight` writes (there are none today)
get an explicit `note: "preflight did not run…"` rather than a silent `null`.

**F5 — absolute over relative, matching the siblings.** The finding offered
"treat an empty sweep as NOT clean"; judging against the absolute `e2e-|qds-`
population makes an empty listing a real claim ("no box of ours exists") instead
of a vacuous one ("nothing in `[]` survives"), so the empty-sweep special case
stops being needed and three variables get deleted. `sweepError` became a
`destroyFailures` entry, and a failed final listing leaves `finalBoxes ===
undefined`, which `fleetCleanupProblems` already reports as a problem (D6's
rule). Fail-safe and consistent with all eight sibling tiers.

**F17 — revoke-first ordering, and belt-and-braces in T5.1.** `keyLeakProblems`
revokes a survivor before reporting it, so the operator finds the key already
dead. Needing the fallback is still a run failure, because needing it IS the
teardown defect. In T5.1 I KEPT the unconditional EB2 `revokeQuietly` ahead of
the delta rather than replacing it: a key the provider has not listed yet is
invisible to a population diff, so the record-driven revoke is the belt to the
delta's braces. `list` is injectable ONLY so the verdict could be pinned offline.

## F17 roster — every test body I own, and whether it mints a key

| Test | Mints a key? | Wired? |
|------|--------------|--------|
| T2.1 `tier2-dispatch-engine` | yes (dispatch) | ✅ |
| T2.2 `tier2-fanout-bestofn` | yes, ×2 (one per arm) | ✅ |
| T3.3 `tier3-expose-port` | yes, ×2 (neg + pos dispatch) | ✅ |
| T3.2 probes `tier3-manystories` (1st test) | **NO** — every probe is a pre-mint refusal (exit 2/5); the test itself asserts zero side effects at `:150-153` | n/a, deliberately skipped |
| T3.2 happy path `tier3-manystories` | yes, ×2 | ✅ |
| T3.1 `tier3-race` | yes, ×2 (and the degraded field leaves one LIVE by design mid-body) | ✅ |
| T3.4a `tier3-reaper` | yes — dispatches SIGKILLed mid-flight, the likeliest strander in the suite; roster built from `sweptRunIds` | ✅ |
| T3.4b `tier3-reaper` | yes (full dispatch to `ready`); "key revoked" is half its own title and was asserted only on the happy path | ✅ |
| T3.5 `tier3-remote-phases` | yes | ✅ |
| T4 `tier4-resident` | yes, ×2 (dispatch's + the resident key this test mints by hand) | ✅ |
| T5.1 `tier5-gate-steering` | yes | ✅ converged onto the helper |

**Hand to wave 2 (tier1 files — I did not touch them):** `tier1-teardown`,
`tier1-approval-gate`, `tier1-image-contract`/`tier2-image-contract`,
`tier1-registry-auth`, `tier1-harvest`, `tier1-provision-status`,
`tier1-driver-lifecycle`, `tier1-attach-transport` all provision and most mint.
`keyLeakProblems` is exported and additive — wiring them is the same four lines
per body (`hashesBefore` → `keyProblems` → spread into `settleRun`).
`tier1-fanout-refusal` and `tier1-lock` should be checked for whether they mint
at all before being wired.
