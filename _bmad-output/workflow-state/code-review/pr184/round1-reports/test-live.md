# W2-C fix report — `tests/fleet/e2e/tier1-image-contract.live.test.ts`

One file edited: `/Users/steve/QDS-Factory/tests/fleet/e2e/tier1-image-contract.live.test.ts`.
No commits, no `git add`. **No live run was performed** — this file spends real money on
real exe.dev boxes; every verdict below is from reading the real file, the real harness
(`live-harness.ts`), the real driver/transport/credentials source, and both sibling live
tests, plus `bunx tsc --noEmit`, `biome check tests`, and a gated-off load check.

---

## Verdicts

| # | Finding | Verdict |
|---|---------|---------|
| 1 | `revokeQuietly` can throw before the box is destroyed | **FIXED** |
| 2 | revoke gated on `mintedHash`, not on the record | **FIXED** |
| 3 | `writeEvidence` throwing in `finally` replaces the real failure | **FIXED** |
| 4 | a failed `destroyQuietly` produces a green test | **FIXED** |
| 5 | `pollBootId` has no per-exec timeout | **FIXED — severity partly refuted, see below** |
| 6 | `rebootExit` recorded and never checked | **FIXED** |
| 7 | repo-pin assertions run after the paid `create()` | **FIXED (+ made falsifiable)** |
| 8 | vacuous marker-shape assertions | **FIXED** |
| 9 | the 4096 cap now agrees three ways | **CONFIRMED, documented** |
| 10 | nothing closes `package.json → marker.bunVersion` | **FIXED** |
| 11 | AC6's tmpfiles claim is asserted only in a comment | **FIXED (negative control)** |

### 1. `revokeQuietly` throwing out of the `finally` — FIXED

Verified: `live-harness.ts:484` is `const rec = store.get(runId);`, above the `try` at
`:488`. Both siblings guard it (`tier1-approval-gate.live.test.ts:552-563`,
`tier1-teardown.live.test.ts:169-175`); this file was the one that did not. The call is now
wrapped in its own try/catch that records `finally-revoke {ok:false}` and never rethrows.

### 2. Revoke gated on the store alone — FIXED

Verified against `src/providers/credentials.ts`: `deps.store.set(runId, { keyHash: res.hash })`
is followed by the malformed-hash refusal and then the `uncapped-key` refusal, both of which
throw *after* the record carries a hash for a key that exists at the provider. The guard is
now `if (store !== undefined)`; `revokeQuietly` already returns `"none"` with no API call when
the record has no `keyHash` (`revokeRunKey`, `credentials.ts:519`), so the old `mintedHash`
half bought nothing.

### 3. `writeEvidence` masking the real failure — FIXED

`try { writeEvidence } catch { stderr } finally { rmSync(workspace) }`. Same shape D6 ratified
in `tier1-approval-gate.live.test.ts:584-594`.

### 4. Failed destroy now fails the run — FIXED

`destroyQuietly` can only *record*, and nothing reads the evidence array. Since I do not own
`live-harness.ts`, the destroy is inlined here (the import was dropped) so the failure lands in
a variable and on stderr with a copy-paste remediation, and `expect(destroyError).toBe("")`
runs **after** the try/finally — reached only on the success path, so it can never mask a real
failure and can only redden a run that leaked a live box.

### 5. `pollBootId` per-exec timeout — FIXED, and the finding's consequence is overstated

The defect is real: the loop condition is evaluated only between attempts, so the budget was
not enforced in flight. **But `driver.exec` is not unbounded.** `exec` passes
`timeoutMs: this.execTimeoutMs` (`driver.ts:942-955`), defaulting to
`DEFAULT_EXEC_TIMEOUT_MS = 120_000`, and `sshCommand` hands that to `Bun.spawn({timeout,
killSignal:"SIGKILL"})` (`transport.ts:48-83`). A hung ssh is therefore SIGKILLed at 120 s and
*returns* (exit 137); it does not run to the bun file timeout. The true exposure was an
overshoot of ≤ one 120 s attempt per poll leg (≤ 240 s total) against a 1 500 s ceiling — the
budget arithmetic in the file's closing comment was 240 s optimistic, not a box-leak path.
Fixed anyway: `execTimed(vm, argv, Math.min(BOOT_PROBE_TIMEOUT_MS /* 30 s */, left()))`, the
budget re-checked before the sleep, and the sleep clamped to what is left. The closing budget
comment now states this correction rather than the old claim.

### 6. `rebootExit` checked — FIXED

A refused `sudo -n reboot` (no passwordless sudo for `exedev`) exits 1 with the reboot never
issued. The expected shapes are enumerated and tolerated — a thrown exec, exit 0, exit 255
(ssh connection died mid-flight) and 137 (local SIGKILL teardown), the same pair
`transport.ts` names — and anything else throws immediately, naming the exit and the stderr,
instead of burning REBOOT_BUDGET_MS to report the opposite diagnosis.

### 7. Pin assertions moved before `create()` — and made falsifiable

Moved to immediately after `preflight("2")`. **Correction to the finding's premise:**
`preflight` builds the driver with `new ExeDevDriver()` (`live-harness.ts:95,102`), not
`exeDevDriverFromEnv`, and the constructor reads no environment (`driver.ts:480-483` —
`opts.image ?? DEFAULT_IMAGE_REF`). So as written these two lines are constant-vs-constant and
cannot fail regardless of where they sit. Moving them is still right (free preconditions), and
I added the half that *can* fail: `QDS_EXEDEV_IMAGE` / `QDS_EXEDEV_IMAGE_BUILD_ID` must be
unset, because production builds the driver via `exeDevDriverFromEnv`
(`src/providers/index.ts:138`) which *does* read them — an operator with one exported is proving
an image their production boxes will not boot. Making the driver itself env-derived belongs to
`live-harness.ts`, which I do not own.

### 8. Vacuous marker-shape assertions — FIXED

Verified `parseImageMarker` (`transport.ts:247-283`): it refuses any input whose six fields are
not non-empty strings, then returns an object literal of exactly those six keys. Dropped:
`Object.keys(marker).length === 6`, the all-six-non-empty loop, `marker.bunVersion.length > 0`,
`marker.piVersion.length > 0`. Kept `bunObserved.length > 0` and `piObserved.length > 0` — both
are reads off the BOX, and `piObserved` is a regex `?.[0] ?? ""` that genuinely yields `""` on
unexpected output. The replacement is finding 10, which tests the box rather than the parser.

### 9. Marker cap — confirmed in agreement, boundary documented

Post-Wave-1 the gate refuses at `Buffer.byteLength(content) >= 4096` and
`IMAGE_MARKER_MAX_BYTES`'s own doc now says "EXCLUSIVE and counted in BYTES, matching the
producer". `stat -c %s` here is the same byte count the Dockerfile's `-lt 4096` uses, so
`toBeLessThan(IMAGE_MARKER_MAX_BYTES)` agrees exactly: a marker of exactly 4096 bytes is
refused by the build, the gate and this line. Stated in the comment. No extra assertion is
possible from here — this test reads a real box's marker and cannot manufacture a 4096-byte
one; the exact-boundary case belongs to the unit suite (W2-A).

### 10. `package.json → box` loop closed — FIXED

`readBunPin` is imported from `scripts/build-exedev-image.ts` (the production build script's
own reader, not a second parser) and `expect(bunObserved).toBe(repoBunPin)` is asserted beside
the marker comparison, with the raw triple recorded as a `bun-pin-loop` phase. Import safety
checked: the script's only top-level statement is `const leaked = {…}` and its entry is
`if (import.meta.main) main()` at `:1816`, so importing it runs nothing —
`tests/scripts/exedev-bun-pin.test.ts` already imports it the same way.

### 11. AC6 negative control — FIXED

The claim "no code path of ours recreated `/run/steering`" was asserted only in a comment, and
`pollBootId` calls `exec` repeatedly inside exactly that window. It is now falsified directly,
after every AC6 assertion has passed and on a box about to be destroyed: `sudo -n rm -rf
/run/steering` → one more `exec` → `stat`. The directory must **stay gone**. If it comes back,
some code path of ours provisions it and every AC6 assertion above proved the driver rather
than the image. The `rm` exit and the probe exit are both asserted, so an `rm` that never ran
reads as inconclusive-and-red, not as a pass. `/run/steering` is now a single constant
(`STEERING_DIR`) shared by the stat, the `rm` and the post-reboot stat so the destructive
command cannot drift from the asserted path.

---

## Ordered teardown trace (after these changes)

Success path and failure path both enter the same `finally`. Steps run in this order; each is
individually guarded, so **no step can skip a later one**:

1. **destroy** (`if (vm !== "")`) — `ctx.driver.destroy(vm)`. Throws ⇒ caught: sets
   `destroyError`, writes a stderr line with `ssh exe.dev rm <vm>`, pushes
   `finally-destroy {ok:false}`. Never rethrows. **First** because the box is the uncapped
   leak; the key is capped at 50 000 µ$.
2. **revoke** (`if (store !== undefined)`) — `revokeQuietly`. Throws (record missing /
   unreadable / half-written ⇒ `store.get` before its own try) ⇒ caught, pushes
   `finally-revoke {ok:false}`. Safe after the destroy: `revokeRunKey` talks to the provider
   only and never touches the box (`credentials.ts:516-522`).
3. **evidence write** — `writeEvidence(...)` + stderr path. Throws (unwritable dir, full disk,
   non-serializable phase, or the harness's own secret-scrub refusal) ⇒ caught, stderr only.
   Never replaces the in-flight throw.
4. **workspace rm** — in an inner `finally`, so it runs whether or not step 3 threw.
5. After the block, on the **success path only**: `expect(destroyError).toBe("")` — a leaked
   box turns the run red instead of green-and-silent. On the failure path the original error
   propagates and the destroy failure is in evidence and on stderr.

### Throw sites between provision and teardown — which can still skip the destroy

Traced every one. **Inside the `try`: none.** All of these are caught by the `catch` (which
records `test-error` and rethrows), so the `finally` runs in every case:

`JSON.parse(build-evidence)` · `driver.create` (`vm` is assigned *before* the await, so a
partially-created box is still destroyed) · `expect(created.name)` · `pollBootId` (either leg)
· every AC1/marker/AC2 `expect` · `parseImageMarker` · `readFileSync(package.json)` /
`readBunPin` · `tmpWorkspace`/`mkdirSync`/`new RunRecordStore`/`store.create` (this is the case
where `revokeQuietly`'s `store.get` throws — now caught) · `driver.fill` · `mintRunKey`
(including the post-`store.set` refusal window — now covered by the store-only guard) ·
`deliverRunKey` · `driver.setup` (D1's transport rejection, now typed by Wave 1 but still a
possible throw) · the gate `expect`s · the new reboot-not-issued throw · the negative control.

**Before the `try`** — `liveGate`, `preflight`, the new precondition `expect`s, `runIdFor`.
These skip the `finally` by construction, and nothing has been created or minted at that point
(`preflight` only runs `whoami`), so there is nothing to leak.

**The one remaining path: the bun per-test timeout (1 500 000 ms).** Bun aborts the test body
and the `finally` does not execute — this is stated in the file's closing comment and is
unchanged. It is now materially harder to reach: both poll legs are bounded in flight, so the
legs sum to ≈ 910 s + ≈ 90 s of teardown against the 1 500 s ceiling, where before the two
legs could each overshoot by a 120 s hung ssh. The legs I cannot bound from this file are
`driver.create`, `driver.fill` and `driver.setup` (the gate carries its own
`DEFAULT_GATE_TIMEOUT_MS`); they are the driver's and the gate's budgets, not the test's.

---

## Could not fix inside this file

- **`revokeQuietly`'s `store.get` outside its own try** (`live-harness.ts:484`) — the root
  cause. Three live tests now each carry the same guard because the shared helper does not.
  One `try` moved up two lines in the harness would delete all three. Harness is not mine.
- **`destroyQuietly` can only record, never report** (`live-harness.ts:460-467`) — same shape.
  I inlined the destroy rather than reading back the evidence entry it pushes; a
  `Promise<boolean>` (or a thrown-through variant) in the harness would let all callers surface
  it.
- **`preflight` builds `new ExeDevDriver()`, not `exeDevDriverFromEnv`** — so the repo-pin
  assertions cannot be falsified by an image override, and no live test exercises the factory
  production actually registers. Recorded as finding 7; fixing it is a harness change.
- **Exact-4096 marker boundary** — not expressible against a real box (see finding 9); belongs
  to W2-A's unit suite.
- **`/run/steering` recreation by a *future* `create()`-like path** — the negative control
  proves `exec` does not provision. It cannot prove it for driver methods this test never calls
  in that window; it does not need to, since the window contains only `exec`.

---

## Gate output

```
bunx tsc --noEmit
  exit=2 — ONE error, and it is not mine:
  tests/providers/exedev/image-assets.test.ts(387,35): error TS2769 (string | undefined)
  grep 'tier1-image-contract' over the full log: no matches — my file type-checks clean.

bunx @biomejs/biome check tests
  Checked 164 files in 3s. No fixes applied.  (exit 0)

env -u QDS_E2E_LIVE -u QDS_E2E_TIER bun test tests/fleet/e2e/tier1-image-contract.live.test.ts
  0 pass · 1 todo · 0 fail        (exit 0)
  The todoIf gate holds: with QDS_E2E_LIVE unset the body does not execute.
```

No live run was performed: no box was created, no key minted, no OpenRouter call made.
