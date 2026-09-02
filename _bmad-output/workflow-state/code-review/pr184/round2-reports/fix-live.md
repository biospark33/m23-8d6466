# fix-live — PR #184 round 2, live-harness cluster (tests/fleet/e2e/**)

All edits are structural; live tests cannot be run (real money). Structural gates below.

## Dispositions

1. **[seams F1, verdicts] FIXED.** Every listed caller now accumulates `destroyQuietly`'s
   verdict into a per-test `destroyFailures: string[]` (declared beside the other outcome
   vars) and asserts `expect(destroyFailures).toEqual([])` AFTER the try/finally, outside
   every catch, before the held body error is re-thrown. Files/sites (re-located):
   tier2-dispatch-engine (1 site), tier2-fanout-bestofn (loop), tier3-race (loop),
   tier3-manystories (loop, 2nd test), tier3-remote-phases (1), tier3-reaper (5 sites
   across both tests, incl. the body-side attempt-cleanup destroy), tier3-expose-port
   (3 sites incl. the pos-retry body destroy and the sweep), tier4-resident (1).
   To make the assertion reachable on red paths, each file's body catch was converted
   from `throw e` to the held-failure shape (`failure = e` … `if (failure !== undefined)
   throw failure` last) — tier1-teardown's EB3 pattern, with EB3-style comments.
   (tier5's discarded destroy verdicts were left: its post-finally `t51BoxAbsence`
   verdict already renders the box outcome, per the seam report's own accounting.)
2. **[seams F1, swallowed leak expect] FIXED.** In all 8 files the `expect(final).toEqual([])`
   inside the finally's try was replaced by `finalBoxes = final` (hoisted
   `let finalBoxes: string[] | undefined`), asserted post-finally as
   `expect(finalBoxes).toEqual([])` — `undefined` (listing threw) fails too, so
   "could not look" never reads as "nothing leaked". The "a leak is a failure even when
   the test already failed" comment now lives where it is true and says why it moved.
3. **[blind F1] FIXED.** tier1-image-contract asserts
   `expect(evidence.filter(p => p.phase === "finally-revoke" && p.ok === false)).toEqual([])`
   beside `expect(destroyError).toBe("")`, EB3-style comment. Per F12: the comment states
   the store is constructed adjacent to `store.create(runId)`, so a routine early abort
   produces no phantom entry, and a half-written record SHOULD fail the line.
4. **[blind F2] FIXED.** tier1-approval-gate: both T1.7 and D8 finallys keep their
   list-before-destroy shape but route the actual destroy through the harness
   `destroyQuietly`, accumulate the verdict (`destroyFailures` / `d8DestroyFailures`),
   and additionally accumulate a LIST-probe failure from the surrounding catch (a destroy
   never attempted is as assertable as one that failed). Asserted post-finally, before the
   held body error rethrow (T1.7 got a new assertion; D8's sits beside its existing
   revokeFailures one). `destroyQuietly` added to the file's harness import.
5. **[seams F5] FIXED.** tier3-expose-port sweep: caller probes `store.get(vm)` in its own
   try; unreadable record → `sweep-no-record` evidence entry + skip (so
   `finally-revoke ok:false` stays a real alarm); readable record → `revokeQuietly` as
   before. Dead catch + stale "record may predate the key mint" comment deleted. The
   vm==runId safety note is in the new comment ("the fleet creates boxes as
   driver.create(runId), so a box's name IS the run id"). tier5-gate-steering: dead
   catch around `revokeQuietly` deleted (never throws), the permanently-vacuous
   `finally-revoke-error` post-finally assertion deleted; the `finally-revoke ok:false`
   assertion (already present) retained with a corrected comment.
6. **[blind F3] FIXED.** `withStore` is `async` and `return await fn(...)`, so the finally's
   `rmSync` waits for the async body; signature widened to `T | Promise<T>`.
7. **[blind F4] FIXED.** The "destroy CONFIRMED by ls" unit test records every argv the
   fake `run` receives and asserts `rm` occurred and an `ls` verification followed it
   (`lsAt > rmAt >= 0`). Verified against the driver: `destroy` really is rm-then-ls
   (driver.ts F7 contract), so the pin matches production.
8. **[blind F5] FIXED.** `preflight` (live-harness.ts) now emits one loud, recorded stderr
   line when QDS_EXEDEV_IMAGE / QDS_EXEDEV_IMAGE_BUILD_ID are set, naming the variable(s)
   and the refs every box will boot (`driver.image` / `driver.imageBuildId`). Never
   refuses (tenant-mirror rounds are legitimate); image-contract's hard refusal untouched.
9. **[blind F6] FIXED.** AC6 negative control: `expect(steeringResurrected.exitCode).toBe(1)`
   (stat's clean ENOENT miss — consistent with the file's other stats expecting 0 on
   presence); 255 transport death now FAILS as inconclusive. `statStderr` added to the
   ac6-negative-control evidence entry.
10. **[blind F7] FIXED.** pollBootId budget is `Math.max(1, Math.min(BOOT_PROBE_TIMEOUT_MS,
    left()))` with a comment on the check-to-call gap. Verified execTimed's ≤0 contract:
    `execTimed` → `sshCommand` → `Bun.spawn({ timeout: Math.max(1, timeoutMs) })`
    (transport.ts:67) — a non-positive timeout is already clamped to 1 ms, NOT disabled;
    recorded in the comment, floor kept local anyway.
11. **[blind F8] FIXED.** The env-var naming loop now runs BEFORE the `ctx.driver.image` /
    `imageBuildId` assertions; comments rewritten (loop = names the variable for ANY
    override; ref assertions = backstop for non-env drift).
12. **[blind F9] FIXED.** `destroyQuietly`: error is `e instanceof Error ? e.message :
    String(e)`; the stderr remediation write sits in its own try (dead stream under an
    aborting runner cannot throw out of the primitive) and is scrubbed. Verified and
    recorded in the comment: `driver.destroy` gates `vm` through `assertValidRunId`
    (driver.ts:885), so the remediation interpolation cannot carry shell metacharacters.
    Same guard applied to `revokeQuietly`'s stderr write (its never-throws contract is
    unit-pinned; the write was the one remaining throw path).
13. **[blind F10] FIXED (comment-only, the sanctioned minimal option).** The reboot
    whitelist comment now states 137 is ACCEPTED-BUT-UNPROVEN (local SIGKILL can precede
    the remote reboot), that only exit 1 proves non-issuance, and that the poll's
    changed-boot-id requirement is the real proof — the budget burn on an unproven 137
    is the named cost. Poll not restructured.
14. **[blind F11] FIXED/VERIFIED.** Verified: rebootStderr, rmStderr, statOutput,
    statStderr, bun-pin-loop and the revoke/destroy error strings all ride the `evidence`
    array into `writeEvidence`, which scrubs via `scrubDeep` over the whole payload and
    refuses to write on a surviving secret (live-harness.ts). The one path that did NOT
    pass through it — `destroyQuietly`'s direct stderr line — is now scrubbed with the
    same module-local `scrubText` (revokeQuietly's line likewise).
15. **[blind F12] VERIFIED, no separate change.** Covered by item 3's comment: store
    construction and `store.create(runId)` are adjacent in the body, so the new
    `finally-revoke ok:false` assertion cannot phantom-fail a routine early abort.

## Gates

- `bunx tsc --noEmit`: 0 errors in `tests/fleet/e2e/**`. (4 pre-existing/concurrent
  errors remain in `tests/scripts/build-exedev-image.test.ts` — the buildscript
  cluster, outside this agent's scope and being edited by its own fix agent.)
- `bunx biome check` on all 13 touched files: clean ("No fixes applied").
- `bun test tests/fleet/e2e/live-harness.test.ts` (teed, de-CR/ANSI-stripped):
  4 pass, 0 fail.
- Additional structural proof (zero spend): `bun test tests/fleet/e2e/` with
  QDS_E2E_LIVE unset — 4 pass, 23 todo, 0 fail across all 19 files, i.e. every edited
  live file imports, collects and type-checks; the live bodies themselves cannot be run
  here (real money) — for those files the edits are structural and type-checked only.

## Touched files (all under /Users/steve/QDS-Factory/tests/fleet/e2e/)

live-harness.ts, live-harness.test.ts, tier1-image-contract.live.test.ts,
tier1-approval-gate.live.test.ts, tier2-dispatch-engine.live.test.ts,
tier2-fanout-bestofn.live.test.ts, tier3-race.live.test.ts,
tier3-manystories.live.test.ts, tier3-remote-phases.live.test.ts,
tier3-reaper.live.test.ts, tier3-expose-port.live.test.ts,
tier4-resident.live.test.ts, tier5-gate-steering.live.test.ts
