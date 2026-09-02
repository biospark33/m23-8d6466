# Blind adversarial review — chunk-live.diff (PR184 round 2)

Scope: diff only (680 lines). Files: tests/fleet/e2e/{live-harness.ts, live-harness.test.ts,
tier1-image-contract.live.test.ts, tier1-approval-gate.live.test.ts, tier1-teardown.live.test.ts}.
Findings only, no fixes.

## F1 [HIGH] revokeQuietly's ok:false verdict is recorded but never asserted in tier1-image-contract — a failed revoke that used to throw (red) now ships a green test

Location: live-harness.ts hunk @@ -481,11 +517,11 (record read moved inside try) + tier1-image-contract.live.test.ts hunk @@ -371,19 +460,70 (new finally, `await revokeQuietly(ctx.driver, store, runId, evidence)` with no post-finally check).

Claim: the harness docstring and the unit-test header both state "the post-finally assertions in the live tests read those entries" / "fail on it". In tier1-image-contract the ONLY post-finally assertion added is `expect(destroyError).toBe("")` — nothing reads `evidence` for a `finally-revoke ok:false` entry. Before this diff, image-contract called `revokeQuietly` bare (removed lines: `if (store !== undefined && mintedHash !== "") { await revokeQuietly(...) }`), so an unreadable/half-written record threw out of the finally and the test went red. After this diff the same condition lands as an evidence entry nothing asserts on.

Failure scenario: body passes; run record is corrupted (half-written JSON) so `store.get` throws inside revokeQuietly; the minted, spend-capped key is never revoked; `finally-revoke ok:false` is written to evidence; `destroyError` is `""`; test reports GREEN with a live credential outstanding. tier1-teardown's comment names EB3 as the enforcing assertion; image-contract has no equivalent, and this diff removed the one behavior (the throw) that made the condition visible there.

## F2 [HIGH] the "leaked box fails the test" fix exists in exactly one caller — tier1-approval-gate's finally still uses an inline, record-only destroy

Location: tier1-approval-gate.live.test.ts hunk @@ -550,16 +550,10 — unchanged context line directly above the changed revoke call: `evidence.push({ phase: "finally-destroy", ok: false, error: (e as Error).message })` inside an inline try/catch around the destroy.

Claim: `destroyQuietly` was changed to return a `DestroyOutcome` precisely because "a record-only failure shipped a green test on the one outcome a live suite must never report green — a real box still billing". Only tier1-image-contract accumulates and asserts the verdict (`expect(destroyError).toBe("")`). The approval-gate finally visible in this diff does not call `destroyQuietly` at all; its destroy failure is pushed into `evidence` and — per the diff — nothing surfaces it. The teardown-test hunks touch only the revoke call.

Failure scenario: approval-gate T1.7 body passes; `ctx.driver.destroy` fails (substrate blip); `finally-destroy ok:false` is recorded; test reports green; the box bills until a human reads the evidence JSON or the invoice. This is the exact #189-item-2 bug, still live in a file this same diff edited.

## F3 [MEDIUM] withStore's finally deletes the tmp store dir before the async test body finishes — the new unit tests pass only by accident of synchronous prefixes

Location: live-harness.test.ts, `withStore` (diff lines 38–45) and both revokeQuietly tests (`await withStore(async (store) => { ... })`).

Claim: `withStore<T>(fn: (...) => T): T` runs `rmSync(dir, ...)` in a synchronous finally. When `fn` is async it returns a *pending* promise; the finally executes immediately, so the RunRecordStore's directory is removed while the awaited body is still running. The tests currently survive because `store.create`/`store.get` execute in the synchronous prefix before the first await inside `revokeQuietly`.

Failure scenario: any future await introduced before the record read (or an async store method) makes every store operation run against a deleted directory — the "NO keyHash" test would then see a *missing* record and record `finally-revoke ok:false`, flipping `expect(evidence).toEqual([])` into a failure that misdiagnoses the harness, or worse, the missing-record test keeps passing for the wrong reason (dir deleted, not record absent). A cleanup helper in a fresh, unreviewed test file that races its own subject is not proving what the titles claim.

## F4 [MEDIUM] "destroy CONFIRMED by ls" unit test never asserts the ls confirmation happened

Location: live-harness.test.ts, test at diff lines 80–93.

Claim: the fake `run` answers `rm` and `ls`, but nothing asserts `ls` was ever invoked (no call log, no assertion on which argv arrived). The test's title claims the destroy is "CONFIRMED by ls"; the assertions (`res.ok === true`, one evidence entry) are satisfied by a `driver.destroy` that issues `rm` and skips verification entirely.

Failure scenario: `ExeDevDriver.destroy` regresses to rm-without-verify (or the ls result stops being consulted); a box whose `rm` silently failed but exited 0 is reported destroyed; this unit test — the stated pin for teardown semantics (#189) — stays green and the leak is discovered by the bill.

## F5 [MEDIUM] the factory-built preflight driver silently extends env overrides into every live test, while only image-contract guards them

Location: live-harness.ts hunk @@ -87,19 +87,30 (`const driver = exeDevDriverFromEnv()` in `preflight`) + tier1-image-contract.live.test.ts precondition block @@ -87,6 +108,32.

Claim: previously all live tests ran `new ExeDevDriver()` — env-blind. Now `preflight` (used by approval-gate and teardown too, per their imports of `ctx.driver`) honors `QDS_EXEDEV_IMAGE` / `QDS_EXEDEV_IMAGE_BUILD_ID` / `QDS_EXEDEV_REGISTRY_AUTH_FILE`. Only image-contract asserts these are unset; the other live tests gained no such precondition in this diff.

Failure scenario: operator runs the full live suite with `QDS_EXEDEV_IMAGE` exported (e.g. left over from an image-build session). Approval-gate and teardown create REAL billed boxes from the override image and run their assertions — assertions written against the pinned image's guarantees — producing either spurious expensive failures or, worse, green results certifying an image nobody pinned. Image-contract then refuses, so the round reports a mixed signal after money was already spent. A misconfigured env now buys boxes it previously could not influence.

## F6 [MEDIUM] the AC6 negative control passes on a transport failure — `stat` exiting non-zero for ANY reason reads as "the directory stayed gone"

Location: tier1-image-contract.live.test.ts, negative-control block @@ -371,19 +460,70 (`expect(steeringResurrected.exitCode).not.toBe(0)`).

Claim: the control's pass condition is only "stat exited non-zero". `stat` on a missing path exits 1; an ssh connection that dropped exits 255 (the very code the file itself documents as connection death). Both satisfy `.not.toBe(0)`. The `afterExec.exitCode === 0` probe proves reachability on a *previous* connection, not on the stat's.

Failure scenario: `/run/steering` IS resurrected by a lazily-provisioning exec (the exact regression the control exists to catch), but the final stat's ssh connection drops (post-reboot box is the flakiest window in the file) and exits 255 — the control records exit 255, asserts non-zero, and certifies "exec provisions nothing" on the run where exec provisioned something.

## F7 [MEDIUM] pollBootId can hand execTimed a zero or negative timeout at the budget boundary

Location: tier1-image-contract.live.test.ts, pollBootId hunk @@ -154,24 +201,30 (`Math.min(BOOT_PROBE_TIMEOUT_MS, left())`).

Claim: `left()` is re-evaluated between the `while (left() > 0)` check and the `execTimed` call; wall time elapses in between (previous attempt just returned), so the clamp can compute 0 or a negative number. The diff does not establish what `execTimed` does with a non-positive timeout; the common footgun (0 ⇒ "no timeout") reinstates exactly the unbounded hang this constant was introduced to close — on the final attempt, where the remaining budget is smallest and the hang matters most.

Failure scenario: budget nearly exhausted, `left()` returns 12ms at the check, the clamp computes -3ms by call time; if execTimed treats ≤0 as disabled, one hung ssh runs to the driver/file ceiling and the "one path that skips the finally and leaks a billing box" (the file's own words) reopens at the boundary.

## F8 [LOW] the env-var precondition loop that exists to "name the variable" is unreachable for the case it was written for

Location: tier1-image-contract.live.test.ts precondition block @@ -87,6 +108,32.

Claim: `expect(ctx.driver.image).toBe(DEFAULT_IMAGE_REF)` runs BEFORE the `for (const name of [...])` loop. Any `QDS_EXEDEV_IMAGE` override whose value differs from the pin fails the first assertion with the anonymous ref diff; the loop — whose stated purpose is "this names the variable in the failure instead of a ref diff" — only ever fires for an override set to exactly the pin values or for `QDS_EXEDEV_REGISTRY_AUTH_FILE`. The comment sells a diagnostic the ordering does not deliver.

## F9 [LOW] destroyQuietly is treated as never-throw by its callers but writes to stderr before recording evidence — a throwing stderr skips the revoke and the evidence write

Location: live-harness.ts destroyQuietly hunk @@ -456,20 +467,45; call site in tier1-image-contract's finally.

Claim: the catch does `process.stderr.write(...)` BEFORE `evidence.push` and `return`. `stderr.write` can throw synchronously (destroyed stream / ERR_STREAM_DESTROYED under an aborting runner). Unlike revokeQuietly, destroyQuietly carries no never-throws contract, yet image-contract awaits it bare in the finally ahead of the revoke and the evidence write. Additionally `(e as Error).message` on a non-Error throw yields `undefined`, so `DestroyOutcome.error: string` is a lie, the stderr line reads "DESTROY FAILED for vm: undefined", and the remediation text `ssh exe.dev rm ${vm}` interpolates a provider-supplied vm name into a copy-paste shell command.

Failure scenario: destroy fails during a runner-abort where stderr is already torn down; the write throws out of destroyQuietly, out of the finally — key not revoked, evidence file never written, workspace not cleaned — on the run that just leaked a box.

## F10 [LOW] reboot exit whitelist accepts 137 as "reboot issued" when 137 can mean the exec was killed locally before the reboot ever ran

Location: tier1-image-contract.live.test.ts reboot-check hunk @@ -336,13 +409,29.

Claim: the check exists so that "the poll below" never "burns REBOOT_BUDGET_MS ... the opposite diagnosis, four minutes late". But 137 is documented in the same comment as "the local SIGKILL teardown" — a local kill can precede the remote `reboot` taking effect. Accepting it as issued sends the test into the REBOOT_BUDGET_MS poll against a box that never rebooted, producing the exact four-minutes-late misdiagnosis the guard advertises preventing, on the code path the guard explicitly waves through.

## F11 [LOW] new evidence and stderr paths write raw, unscrubbed driver/provider text — under a driver that now loads registry credentials

Location: tier1-image-contract.live.test.ts new evidence pushes (`reboot-issued.rebootStderr`, `ac6-negative-control.rmStderr`/`statOutput`, `bun-pin-loop`), live-harness.ts destroyQuietly stderr line and `finally-revoke ok:false` error string.

Claim: none of these strings pass through any scrub before landing in the evidence JSON or the operator's terminal. This diff simultaneously switches the driver to `exeDevDriverFromEnv`, which loads `QDS_EXEDEV_REGISTRY_AUTH_FILE`; factory/driver error messages (the very refusals the preflight comment celebrates surfacing) plausibly embed file paths, authenticated registry refs, or command lines, and revoke errors originate from the key-API layer. Failure scenario: a revoke failure whose provider error echoes request context is serialized verbatim into a committed-adjacent evidence file; the diff added the paths, not the scrubbing.

## F12 [LOW] the store-only revoke gate in image-contract manufactures a false "revoke failed" verdict on every early abort

Location: tier1-image-contract.live.test.ts finally hunk (`if (store !== undefined)` replacing `store !== undefined && mintedHash !== ""`) + revokeQuietly's new missing-record ok:false behavior.

Claim: a run that constructs the store but dies before the run record exists (e.g. box create throws) now calls revokeQuietly against a missing record, which records `finally-revoke ok:false` — an alarm entry asserting a revoke problem on a run where no key could have been minted. Harmless today only because of F1 (nothing asserts these entries here); the moment F1 is fixed with an evidence assertion, every early abort double-fails with a phantom key leak, training operators to ignore the one entry that matters.
