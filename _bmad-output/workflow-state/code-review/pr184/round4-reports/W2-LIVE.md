# W2-LIVE

Wave-2 fixer, PR #184 review round 4. Exclusive scope: `tests/fleet/e2e/`.
No commits, no staging, no push. The live suite was never run — every gate below
is offline with `QDS_E2E_LIVE` unset.

## Key-leak roster

Every `*.live.test.ts` body in the directory. "Mints a key?" is answered from the
code path, not from the file's prose.

| file (body) | mints a key? | already wired? | wired by me? | evidence |
|---|---|---|---|---|
| `tier1-driver-lifecycle` T1.1 | **no** | n/a | no — nothing to wire | No `KeyApi` reachable: the body is `driver.whoami/create/list/exec/copyFile/destroy` plus shell no-ops (`python3 --version`, `uname -a`, `git --version`). No `fleet` verb runs at all. |
| `tier1-provision-status` T1.2 | **no** | n/a | no — nothing to wire | `createRun` (`src/providers/driver.ts:827`) is headroom-gate → `provisionAdmittedRun`; it constructs no `KeyApi`. `status` is a read. Header's own claim ("no keyHash ⇒ no revoke") verified against the source. |
| `tier1-harvest` T1.3a | **no** | n/a | no — nothing to wire | The "key delivery" leg is `sh -c … printf 'OPENROUTER_API_KEY=not-a-real-key' > app/.env` to measure the FILE MODE. A literal, not a mint. `driver.fill` takes `{runId, repoUrl, commitSha, workdir}` — no credential. |
| `tier1-harvest` T1.3b | **no** | n/a | no — nothing to wire | `fill` → in-box git commit → `harvest` verb (a bundle round-trip). No `KeyApi` on any path. |
| `tier1-teardown` T1.4 | **YES** (`mintCappedKey`, cap 5000 µ$) | no — bespoke delta, and it had a hole (see D1) | **yes** | `keyLeakProblems` now renders the verdict AFTER both existing revoke legs. |
| `tier1-fanout-refusal` T1.5 | **no** | n/a | no — nothing to wire | Every path is a **pre-provision, pre-mint refusal**: the held `FleetLock` makes `fleet fanout` exit 5 before dispatch, and the body proves it against the live provider (`after.length === before.length`, no `fan-` record, no run records). The probe run id is never created. |
| `tier1-lock` T1.6 | **no** | n/a | no — nothing to wire | Record is `store.create` + a hand-set `vmName` only. Header's "minimal record (vmName, no keyHash)" confirmed — and it is *why* the winner may legitimately exit 6. |
| `tier1-approval-gate` T1.7 | **YES** (`mintCappedKey`) | no — bespoke delta that reported but never revoked | **yes** | |
| `tier1-approval-gate` D8 | **YES** (`mintCappedKey`) | no — bespoke delta, two bases | **yes** | |
| `tier1-attach-transport` T1.8 | **no** | n/a | no — nothing to wire | Header: "$0 by construction". `attach` delivers a steering line through `driver.exec`; no `KeyApi` is constructed. |
| `tier1-registry-auth` AC4 | **no** | n/a | no — nothing to wire | The file imports no credential module. It is `exeDevDriverFromEnv` + `create` + a marker read on two image refs. |
| `tier2-image-contract` DF2.10 | **YES** (`mintRunKey` + `deliverRunKey`) | **no** — wave 1 converted it to `settleRun` but left the key half out | **yes** | This was the miss: the hand-off listed it, but its `settleRun` only read `finally-revoke ok:false`, which speaks for the RECORD, not the account. |
| `tier2-dispatch-engine` | yes (via `dispatch`) | **yes** (wave 1) | no | verified: `keyLeakProblems` + `hashesBefore` + `settleRun` |
| `tier2-fanout-bestofn` | yes | **yes** (wave 1) | no | verified |
| `tier3-expose-port` | yes | **yes** (wave 1) | no | verified |
| `tier3-manystories` T3.2 happy | yes | **yes** (wave 1) | no | verified |
| `tier3-manystories` T3.2 **probes** | **no** | n/a — but see N7 | (F11 fix only) | Every probe is a **pre-mint validation refusal**; the body asserts zero side effects against the live provider. Wave 1 wired the happy-path body in this file and left the probe body's unguarded evidence write behind. |
| `tier3-race` | yes | **yes** (wave 1) | no | verified |
| `tier3-reaper` (×2) | yes | **yes** (wave 1) | no | verified |
| `tier3-remote-phases` | yes | **yes** (wave 1) | no | verified |
| `tier4-resident` | yes | **yes** (wave 1) | no | verified |
| `tier5-gate-steering` | yes | **yes** (wave 1) | no | verified |
| `tier1-teardown` D6 | **no** | n/a | no | Zero boxes, zero keys — two real GETs against `/keys`. See FP-2 for why its evidence write is left alone. |

Wave 1's "nine tier2–5 bodies" count is confirmed by grep, and `tier2-image-contract`
is confirmed as the tenth minting body it did **not** wire despite converting the
same file to `settleRun`.

## Patched

| ID | File:line | What changed | Why |
|---|---|---|---|
| T2-a | `live-harness.ts:100` | `tier1-image-contract` → `tier2-image-contract` | Task 2 |
| T2-b | `live-harness.ts:110` | same | Task 2 |
| T2-c | `live-harness.ts:131` | same (inside the operator-facing stderr line) | Task 2 |
| T2-d | `live-harness.ts:530` | same | Task 2 |
| H1 | `live-harness.ts:629-663` `teardownQuietly` | added `opts.okExitCodes` (default `[0]`), used in the `ok` computation and named in the error string | Required by W1/W2/W4 — see N1. Additive: the nine wave-1 call sites pass nothing and keep `[0]` exactly. |
| W1 | `tier1-provision-status:78→` | bare `runFleet(["teardown"…])` in the `finally` → `teardownQuietly(…, {okExitCodes:[0,6]})`; added a `destroyQuietly` box fallback; added the cleanup-time `e2e-\|qds-` listing; `writeEvidence` → `writeEvidenceQuietly`; body error HELD; `settleRun(failure, fleetCleanupProblems(...))` after the `finally` | N2, N3, N4 |
| W2 | `tier1-harvest` T1.3a and T1.3b (both `finally`s) | same three conversions, **plus** deleted `expect(leakSuspect).toBe(false)` from inside the `finally` and folded it into `settleRun` | N2, N3, **N5** (the serious one) |
| W3 | `tier1-driver-lifecycle:93→` | `destroyQuietly`'s discarded verdict now accumulated; cleanup-time listing added; `writeEvidenceQuietly`; body error HELD; `settleRun` | N4, N6 |
| W4 | `tier1-lock:102→` | `driver.destroy` inside a swallowing `catch {}` → `destroyQuietly` with an accumulated verdict; list-probe failure also accumulated; cleanup-time listing; `writeEvidenceQuietly`; `settleRun` | N4, N6 |
| W5 | `tier1-fanout-refusal:94→` | `writeEvidenceQuietly`; lock-release failure now a problem line instead of `catch {}`; body error HELD; `settleRun` | N6, N7 |
| W6 | `tier1-attach-transport:276→` and `:300→` | `destroyQuietly`'s discarded verdict accumulated; cleanup-time listing added; `writeEvidenceQuietly`; **and the post-`finally` `expect(absenceError); expect(ownBoxAbsent); if (failure) throw failure;` replaced with `settleRun`** | **N8** (F4/F6 verbatim), N4, N6 |
| F17-a | `tier1-teardown:200→` | `keyLeakProblems` added after the existing record-revoke + EB4 delta-revoke legs; `key-hash-delta` renamed `key-hash-delta-sweep` and given an explicit `ok`; cleanup-time listing added; `writeEvidenceQuietly`; `settleRun` now takes `fleetCleanupProblems(...)` + `keyProblems` | **D1** — the reporting hole |
| F17-b | `tier1-approval-gate` T1.7 `:619→` | bespoke `leaked`/`deltaError` delta → `keyLeakProblems`; cleanup-time listing added; `writeEvidenceQuietly`; `settleRun` now takes `fleetCleanupProblems(destroyFailures, finalBoxes)` | F17 + Task 3 |
| F17-c | `tier1-approval-gate` D8 `:896→` | bespoke two-basis delta (`d8Hash` vs account) → `keyLeakProblems` (always whole-account); `d8Hash` deleted; cleanup-time listing added; `writeEvidenceQuietly`; `fleetCleanupProblems` | F17 + Task 3 + **D2** |
| F17-d | `tier2-image-contract:587→` | `hashesBefore` snapshot added (after the free preconditions, before any spend); `keyLeakProblems` after the revoke leg; cleanup-time listing added; `writeEvidenceQuietly`; `settleRun` now routes the destroy verdict through `fleetCleanupProblems` | F17 — the body wave 1 missed |
| N7-fix | `tier3-manystories:161→` (T3.2 probes) | unguarded `writeEvidence` in the `finally` → `writeEvidenceQuietly`; body error HELD; `settleRun` | N7 |
| N9-fix | `tier1-registry-auth:356→` | hand-rolled `try/catch` around `writeEvidence` (which only *printed*) → `writeEvidenceQuietly`, folding the failure into `destroyFailures` | N9 |

Every `keyLeakProblems` call passes the real listing — **no `*.live.test.ts` passes
`list`**, verified: `grep -n 'list:' tests/fleet/e2e/*.live.test.ts` is empty; the
seam is used only by `live-harness.test.ts`.

## NEW findings in the previously-unreviewed tier-1 files

These files were reviewed by nobody this round. All are fixed.

| Sev | File:line | Finding | Fixed? |
|---|---|---|---|
| **D1** HIGH | `tier1-teardown:201` (pre-fix) | **The key-leak delta could not fail the test.** The success arm pushed `{phase:"key-hash-delta", stranded}` with **no `ok` key**, while the only reader — `unread(phase) = evidence.filter(p => p.phase === phase && p.ok === false)` — keys off `p.ok === false`. So a NON-EMPTY `stranded` (a real live key the run had just failed to revoke) read as **clean in the exact filter written to find leaks**; only an enumeration *error* could ever fail it. The `finally-delta-revoke` sweep below it is gated on `recordKeyHash === undefined`, so a key the record *did* name and the teardown *did not* revoke was neither revoked nor reported. | ✅ `ok` made explicit + `keyLeakProblems` is now the verdict |
| **D2** MED | `tier1-approval-gate:912` (pre-fix, D8) | **The leak filter narrowed on exactly the path that leaks.** `d8Leaked = d8Hash === "" ? accountDelta : after.filter(h => h === d8Hash)`. The narrow per-hash basis was chosen whenever the mint returned — but a `mintRunKey` tail that throws *after* the provider created a live key is the case the account delta exists for, and that path also leaves `d8Hash === ""` only if the throw beat the assignment. Two bases, of which the strict one is not the fail-safe one. | ✅ `keyLeakProblems` always diffs the whole account |
| **N1** MED | `tier1-harvest:139`, `:229` (pre-fix) | **Wrong reason recorded for a correct exit set.** The comment claimed exit 6 is `harvest_waived` from `--no-harvest`. It is not: `--no-harvest` only *prints* `teardown.harvest_waived` (`scripts/fleet.ts:4208`); the code is `keyUnattributable \|\| !markCleared \|\| !reportedLanding ? 6 : 0` (`:4229`), and `keyUnattributable` is set at `:4110` for an **open record with a `vmName` and no `keyHash`** — which is what every non-minting TIER-1 test builds. A future reader dropping `--no-harvest` would have "fixed" the wrong thing and turned every green round red. | ✅ corrected in all three files; `okExitCodes` documented with the real cause |
| **N2** HIGH | `tier1-provision-status:78`, `tier1-harvest:145`, `:234` (pre-fix) | **F2 — unguarded `await runFleet(["teardown", …])` inside a `finally`.** Its 180 s ceiling firing (or a dead spawn) rejects *at the await*, escaping the `finally`: it skipped the evidence write and the workspace `rmSync` below it, and replaced the body's error with a teardown timeout. | ✅ `teardownQuietly` |
| **N3** HIGH | `tier1-provision-status:75-80`, `tier1-harvest:144-148`, `:233-237` (pre-fix) | **No box fallback at all.** These three `finally`s ran the teardown *verb* and nothing else. A teardown that refused, timed out, or was skipped (`workspace === ""`) left a **real billing box** with no `destroyQuietly` anywhere in the file, and the non-zero exit was pushed into `evidence`, which nothing reads during the run. A leaked box shipped green. | ✅ `destroyQuietly` fallback + accumulated verdict |
| **N4** HIGH | `tier1-driver-lifecycle:95`, `tier1-attach-transport:284` (pre-fix) | **`destroyQuietly`'s verdict discarded.** `await destroyQuietly(...)` with the return value thrown away — the #189 defect wave 1 removed elsewhere, still live in two files. A destroy that failed recorded `ok:false` into `evidence` and the test reported green on a box still billing. | ✅ accumulated into `destroyFailures` → `fleetCleanupProblems` |
| **N5** HIGH | `tier1-harvest:158`, `:245` (pre-fix) | **A cleanup `expect` INSIDE the `finally`.** `expect(leakSuspect).toBe(false)` as the last statement of the `finally` — strictly worse than the F4/F6 shape wave 1 deleted, which at least sat *after* the block. An `expect` that throws here **overwrites the in-flight body error outright**, and the body `catch` here did `throw e` (nothing held). A run that hit both an F3-regression and a leaked box reported `expected false to be true` and the real regression was gone. | ✅ folded into `settleRun` as a problem line attached to the held error |
| **N6** MED | `tier1-driver-lifecycle:97`, `tier1-provision-status:81`, `tier1-fanout-refusal:100`, `tier1-lock:112`, `tier1-harvest:149`,`:238`, `tier3-manystories:162` (pre-fix) | **F11 — `writeEvidence` in a `finally` with no catch.** It throws on ENOSPC/EACCES and on the **secret-scrub refusal**, so the one condition that most needs the verdict machinery is the one that skipped it: the throw propagated out of the `finally`, replacing the body's real failure and (in five of the seven) skipping the workspace `rmSync` on the next line. | ✅ `writeEvidenceQuietly` in all seven |
| **N7** MED | `tier1-lock:109`, `tier1-fanout-refusal:97` (pre-fix) | **Swallowing `catch {}` over a real cleanup.** `tier1-lock` swallowed *both* a failing `list` and a failing `driver.destroy` — a box still billing left no verdict anywhere. `tier1-fanout-refusal` swallowed a `FleetLock.release` throw, which is a fact about the very primitive under test. | ✅ both accumulated as problem lines |
| **N8** HIGH | `tier1-attach-transport:317-319` (pre-fix) | **F4/F6 verbatim, and nobody had looked at it.** `expect(absenceError).toBeUndefined(); expect(ownBoxAbsent).toBeTrue(); if (failure !== undefined) throw failure;` — cleanup `expect`s ahead of the held-error rethrow. On a run carrying BOTH an attach-transport regression and a leaked box, the first `expect` threw its own AssertionError and the held body error was discarded; the operator reads "box still listed" where the transport regression was, and pays for another 900 s live round to rediscover it. This is the exact shape the round spent itself deleting, sitting in a file the round never opened. | ✅ `settleRun` |
| **N9** LOW | `tier1-registry-auth:365` (pre-fix) | An evidence-write failure was **printed and nothing more**. Not the F11 masking bug (the catch is real), but this file's whole subject is a private-registry credential, so "the secret-scrub refused to write this file" is the one message that must be a verdict rather than a stderr line on a green run. | ✅ `writeEvidenceQuietly` folding into `destroyFailures` |

## False positives

**FP-1 — the reported `lint/style/useConst` in `tier3-remote-phases.live.test.ts:73`
does not exist. NOT PATCHED.**

The hand-off says wave 1 left `let keyProblems: string[] = []` tripping `useConst`.
It does not, and `useConst` is right not to fire: the binding **is reassigned**.

```
$ grep -n "keyProblems" tests/fleet/e2e/tier3-remote-phases.live.test.ts
73:    let keyProblems: string[] = [];
236:      keyProblems = await keyLeakProblems(      ← the reassignment
259:    settleRun(failure, [...fleetCleanupProblems(destroyFailures, finalBoxes), ...keyProblems]);

$ bunx biome check tests/fleet/e2e/
Checked 21 files in 329ms. No fixes applied.        ← exit 0, on the pre-edit tree too
```

`let` is *required* here — `const` would not compile. Changing it to `const` would
have been a red build. The same `let … ; assigned-in-finally` shape is what I used
in every body I wired, for the same reason.

**FP-2 — `writeEvidence` in `tier1-teardown`'s D6 `finally` is NOT the F11 defect.
NOT PATCHED.** It already has a real `catch` that prints and does not rethrow, so it
cannot mask the body's failure, and there is no `settleRun` below it to make
unreachable. It is the N9 shape (a failure reported only on stderr) rather than the
N6 shape — and unlike `tier1-registry-auth`, D6 provisions no box, mints no key, and
its payload is counts plus a truncation message whose only key-shaped text is the
literal, unexpanded string `$OPENROUTER_PROVISIONING_KEY`. There is no path by which
that write can hit the scrub refusal. Converting it would mean restructuring a test
that has no held-failure machinery at all, to report a condition it cannot produce.

**FP-3 — wave 1's `teardownQuietly` calls are not silently mis-scoring exit 6.**
I checked this before adding `okExitCodes`: the nine wave-1 bodies tear down runs
created by `dispatch`, whose records carry a `keyHash`, so `keyUnattributable` is
false and exit 0 is the real success code there. `[0]` is correct for them and they
are untouched.

## Gate output

Real output, all six, offline (`QDS_E2E_LIVE` and `QDS_E2E_TIER` unset).

**1. `bunx tsc --noEmit`** — clean, no error in any file I touched:
```
tsc exit=0
```

**2. `bunx biome check tests/fleet/e2e/`** — clean:
```
Checked 21 files in 329ms. No fixes applied.
```

**3. `env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test tests/fleet/e2e/`**
```
exit=0
=== failures (tr/perl-normalised, as required) ===
(grep exit=1 — no matches)
=== summary ===
 12 pass
 24 todo
 0 fail
 43 expect() calls
Ran 36 tests across 20 files. [874.00ms]
```

**NO BOX WAS PROVISIONED AND NO MONEY WAS SPENT.** How I know, three independent ways:

1. **The counts are exact.** `grep -h "test.todoIf(liveTodoOff())" *.live.test.ts | wc -l`
   = **24**, and the run reports **24 todo**. Every single live body reported `todo`
   — not one executed. The 12 `pass` are exactly the 12 unit tests in
   `live-harness.test.ts` (`Ran 12 tests across 1 file`, gate 4).
2. **The gate is structural, not conditional.** A `todo` body is never invoked by
   bun, so `preflight()` — the only place `exeDevDriverFromEnv()` and
   `driver.whoami()` are reached — never ran. No `driver.create`, no
   `mintCappedKey`/`mintRunKey`, no `listedKeyHashes()`, no `runFleet` subprocess.
   The new `const hashesBefore = await listedKeyHashes()` I added to
   `tier2-image-contract` is *inside* the body, so it is skipped with it.
3. **Belt and braces.** With `QDS_E2E_LIVE` unset, even a body that did run would hit
   `liveGate()`'s first line and THROW ("QDS_E2E_LIVE is not 1") before touching the
   substrate. The suite is 874 ms; a single real `ssh exe.dev new` is minutes.

No new evidence JSON was written to `_bmad-output/evidence/df3-e2e` by this run.

**4. `bun test tests/fleet/e2e/live-harness.test.ts`** — the one thing here that
really runs, still green after the `keyLeakProblems` rollout and the
`teardownQuietly` signature change:
```
 12 pass
 0 fail
 43 expect() calls
Ran 12 tests across 1 file. [304.00ms]
```

**5. `grep -rn "tier1-image-contract" tests/fleet/`** — empty:
```
matches=1  (grep exit 1 = zero remain)
```
(The three surviving references repo-wide are in `scripts/build-exedev-image.ts`,
which is outside my scope and belongs to another fixer.)

**6. Completeness grep for the F2 class.** `grep -n 'runFleet(\["teardown"' tests/fleet/e2e/*.live.test.ts`
returns 12 real call sites (plus one match inside a comment I wrote in
`tier1-harvest:149`). Proven by line ordering — each hit is strictly BEFORE its own
test's `} catch (e) {`, i.e. inside the try BODY, where a rejection SHOULD fail the
test — and never inside a `finally`:

| file | teardown@ | its test starts@ | its `} catch`@ | its `} finally`@ | verdict |
|---|---|---|---|---|---|
| `tier1-approval-gate` | 785 | 721 (D8) | 867 | 874 | body ✅ |
| `tier1-teardown` | 115, 151 | 53 | 154 | 162 | body ✅ |
| `tier3-expose-port` | 157, 186, 233 | — | 253 | 259 | body ✅ |
| `tier3-remote-phases` | 193 | — | 201 | 207 | body ✅ |
| `tier2-fanout-bestofn` | 244 | — | 278 | 284 | body ✅ |
| `tier2-dispatch-engine` | 283 | — | 320 | 326 | body ✅ |
| `tier3-manystories` | 334 | 170 (test 2) | 368 | 374 | body ✅ |
| `tier5-gate-steering` | 440 | — | 658 | 665 | body ✅ |
| `tier4-resident` | 522 | — | 532 | 538 | body ✅ |

The three pre-existing `finally` hits (`tier1-provision-status:78`,
`tier1-harvest:145`, `tier1-harvest:234`) are gone — converted to `teardownQuietly`.
Zero `finally` hits remain.

## Decision on Task 3 (the `fleetCleanupProblems` asymmetry) and why

**The wave-1 fixer's reasoning is locally correct and globally wrong. I took the
fail-safe option: `tier1-approval-gate` (T1.7 *and* D8), `tier1-teardown` and
`tier2-image-contract` now take a REAL cleanup-time fleet listing and pass it to
`fleetCleanupProblems`.** I added the same listing to every other body I touched
(`tier1-driver-lifecycle`, `tier1-provision-status`, `tier1-lock`, `tier1-harvest`
×2, `tier1-attach-transport`), so the absolute `e2e-|qds-` backstop now covers the
whole directory, not nine of nineteen.

What wave 1 got right: `driver.destroy` really does confirm absence with a real `ls`
before returning, so `destroyQuietly`'s verdict genuinely carries the "is it gone"
half **for the box it was asked to destroy**.

What that misses is the entire point of the backstop. It is not a second opinion on
a box you already named — it is the only check that can see a box **nobody named**:

- a `driver.create` that stands the box up and then throws leaves the `vm` variable
  `""`, so the destroy leg is skipped by its own guard and `destroyQuietly` reports
  a clean nothing;
- a `fleet` verb subprocess that provisions and dies mid-flight owns a box this test
  never held in a variable at all;
- an orphan from a crashed prior arm.

And the specific claim — "approval-gate's final-ls is a BODY assertion" — is an
argument *for* the change, not against it. A body assertion is skipped **on exactly
the runs that leak**, because a body that threw never reaches its last line. T1.7's
final-ls sits at `:576`, after ~450 lines of gate work; it protects the green path,
which is the path that does not need protecting. That is the same reasoning wave 1
itself used to move `finalBoxes` out of the `finally`'s `catch` in round 2 (F1), and
to hold the body error instead of throwing it (EB3). It applies here unchanged.

On the two objections, directly:

- *"Passing `[]` would assert a listing that was never taken."* Correct, and I did
  not do that. I **take** the listing. The fix for "we have no measurement" is to
  measure, not to skip the check.
- *"Passing `undefined` would always report the final fleet listing FAILED."* Only
  if you pass `undefined` unconditionally. `undefined` now means what
  `fleetCleanupProblems` documents it to mean — the `ctx.driver.list()` in the
  `finally` threw — and reporting that is correct, not noise. It is D6's ratified
  rule, already load-bearing for nine files: **an unmeasured fleet is never a clean
  one**, exactly as an unmeasured key population is never "nothing leaked".

The asymmetry also cost these files a *cheaper* property than correctness:
uniformity. Nine bodies got the backstop and ten did not, on a per-file judgement
call that no future reader could reconstruct — which is how `tier2-image-contract`
came to be converted to `settleRun` in this very round while quietly keeping neither
the key delta nor the fleet listing.

Cost of being wrong in each direction, which is what settles it: a spurious problem
line costs one re-read of an evidence file. A leaked box that no listing looks for
bills until someone opens the invoice. The serial-round presumption the filter relies
on is already stated in these files and mandated by the `qds-live-e2e` skill.
