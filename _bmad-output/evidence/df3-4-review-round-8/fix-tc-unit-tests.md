# T-C fix report — tests/fleet unit tests (round 7, wave 2)

Files touched: `tests/fleet/approvers.test.ts`, `tests/fleet/verbs.test.ts`, `tests/fleet/attach.test.ts`.
`tests/fleet/fixtures/approvers.json` needed no change (verified both entries' hashes; see bob finding).
Final: `bun test` 214 pass / 0 fail across the three files; `bunx tsc --noEmit` clean; `biome check` clean. No commits.

## HIGHs

1. **Enrol absent-`.factory` arm (approvers.test:982) — FIXED, with a source defect found.**
   Probing a genuine fresh host (`mkdtemp` with no `.factory`) showed `enrolApprover` **refuses** with
   `approver-allowlist-dir-mode` ("create …/.factory with mode 0700") — it does **not** mkdir. This contradicts
   `enrolApprover`'s docstring ("The ONE arm that is not simply 'propagate the refusal' is a file that does not
   exist yet, which is the first enrolment on a host and must obviously work"): the guarded read's ancestor walk
   stats `.factory` before the absent-FILE arm is reachable, so the very first `fleet enrol` on a real host fails
   until the operator hand-creates the directory. Not edited in `src/` per instructions. The blind report's
   proposed fix ("assert the created dir is 0700") was not writable as stated because nothing is created; instead
   two tests now exist: one pins the real fresh-host refusal (typed code, `create`+`0700` remediation, nothing
   written), and the pre-existing happy-path test keeps its title but its comment now says "PREPARED host" and the
   false claim is confined to the pinned-refusal test's comment. **If the writer is later taught to mkdir 0700,
   the pinned-refusal test turns red — by design.**

2. **Registry snapshot dead data (verbs.test:641) — FIXED.** The hand-written loop list is gone; the per-verb
   snapshot test now iterates `Object.keys(EXPECTED_FLAGS)`, so enrol/unlock's flag tables (verbatim `--rotate`/
   `--force` notes, `--approver required:true`) and exit codes are pinned by the same snapshot that covers the
   other nine verbs. Added a companion test asserting both records' key sets equal the registry's verbs exactly,
   so an orphaned record entry (verb renamed away) is also a failure.

3. **INV-APPROVE-5 negative control can't detect non-delivery (attach.test:335) — FIXED.** The forged-abort test
   now destructures `prompts`, captures the attach result, and asserts delivery before asserting the invariant:
   `outcome === "attach-acked"`, one prompt, the forged `pwned` payload present in both the rendered prompt and
   `promptContext`. Only then are `directive === proceed` / `directives === 1` / rejected 0 / no tripwires
   asserted. A silent non-delivery now fails the delivery asserts instead of passing vacuously.

## MEDs

- **Hash-shape conflation (approvers.test:629) — FIXED.** The four `test.each` cases now build a complete v2
  entry with only `hash` overridden, so the pinned `/^[0-9a-f]{64}$/` regex is what fires, not missing-field
  refusals. Empty-salt case fixed the same way (it previously passed a hash computed at salt `""`, conflating
  arms).
- **Scrypt exact boundary (approvers.test:931) — FIXED.** New test: `N=2^20, r=8` is exactly
  `SCRYPT_ALLOC_CEILING_BYTES` and is **accepted** (verified against source: the refine is strict `>`); the
  entry's hash is computed at its own params. Test carries a 15 s bound (the verification costs ~2.5 s — the
  cost the ceiling exists to bound, paid once deliberately).
- **BOM invisible (approvers.test:648) — FIXED.** The U+FEFF is extracted to `BOM`, asserted to encode to 3
  bytes, and the written file is re-read and asserted to start with it before the authenticate assertion.
- **Bob fixture round-trip (fixtures/approvers.json) — FIXED (test side; fixture unchanged).** Verified with an
  independent scryptSync oracle that both fixture entries' hashes match their documented sentinels today; the
  fixture test now also authenticates `bob@example.test` / `fake-approver-token-bob` and asserts the entry
  exists, so a rotten second entry fails.
- **Dir-mode write-bit-absent side (approvers.test:257) — FIXED.** `0o500` added to the allowed loop (source
  verified: 0500/0550 both authenticate — the rule is the `& 0o022` mask). Loop restores 0700 in a `finally` so
  afterEach's rmSync doesn't turn a failure into ENOTEMPTY teardown noise.
- **Vacuous cap-guard (test-results.test.ts:361) — DEFERRED, out of scope.** `tests/phase-engine/test-results.test.ts`
  is not in this fixer's file set (assigned to T-B's chunk). Not touched.
- **Argue-here self-violation for enrol (verbs.test:1973) — FIXED.** Comment rewritten: names all five verbs,
  argues enrol's driver-less-ness (writes `.factory/approvers.json`, never touches a box), and the "a FIFTH must
  argue" line corrected to SIXTH.
- **Attach 20s opaque timeout (attach.test:321) — FIXED.** The pausing/awaiting-approval refusal probe now passes
  `{ceilingMs: 60, pollIntervalMs: 20}` so a guard regression reports `no-ack` in milliseconds instead of
  polling the 30 s default into bun's 20 s kill.
- **Auth-failure exit unobserved (verbs probes) — FIXED.** `gateDeps` now takes an optional auth override; new
  probes for approve AND reject inject `{ok:false, refusal: approver-token-mismatch}` and pin exit 5, the code on
  stderr, stdout exactly empty, and the paused record untouched (`state` still `awaiting-approval`).
- **Success probes assert stdout, not the record (verbs probes) — FIXED.** Added an `after` hook to the Probe
  runner (awaited post-invocation); approve/reject success probes now assert the PERSISTED record:
  `extensions.approval.{state, approverId}` and a parseable `decidedAt`.
- **FleetError literal regex (verbs.test:272) — FIXED where safe.** Enumerated the real non-literal sites: they
  are `refuse()` (dispatch.ts) and `invalid()` (fanout-primitive.ts), both construct from a parameter typed by an
  annotation. The scan now also reads every `exitCode: <union>` type annotation and fails if any union admits 6.
  Verified the widened regex matches exactly the two real sites and nothing else. Dynamic values with no
  annotation are still invisible to a text scan — noted as residual, not fixable from the test side.

## LOWs

- **0400 file mode — FIXED.** New test: 0400 authenticates (source verified; the guard is the `& 0o077` mask,
  not an exact-0600 equality), separating the two rules the 0600/0640/0644 trio could not.
- **Drip bounds (approvers.test:528) — FIXED.** `sent < MAX_TOKEN_BYTES/1000` (≤4 bytes is the discriminating
  bound at a 60 ms deadline with 15 ms stalls); wall-clock ceiling relaxed to 60 s with a comment — it only has
  to be orders of magnitude under the ~10 h the reset bug parks for, so a stalled CI runner can't red correct
  code.
- **Stale-lock pid recycle (approvers.test:1141) — FIXED.** Death is re-proved (signal-0/ESRCH, same discipline
  as the source's `isLockHolderDead`) immediately before the enrol, with one re-mint retry and an explicit skip
  error if the platform won't cooperate — the test can no longer fail as "locked" about the platform instead of
  the reclaim.
- **streamOf dup (approvers.test:491/694) — FIXED.** Hoisted to one module-scope helper; both describes share it.
- **Mode-ordering unfalsifiable (approvers.test:161) — FIXED.** The 0644 test now spies `fs.readFileSync` to
  throw if the guard reads before refusing, making the ordering claim falsifiable for the mode arm (the spy is
  restored in `finally`).
- **Non-default-N vacuous (approvers.test:903) — FIXED.** Asserts `entry.N === TEST_SCRYPT.N` outright plus
  `!== SCRYPT_PARAMS.N`; the `"v" in entry ? …` vacuity is gone.
- **Ancestor message relax (approvers.test:205) — FIXED.** Dropped `not.toContain(".factory")`; the requirement
  (offending component + mode named) is kept, and a remediation that also names the file under it is allowed.
- **ARGUED_EXEMPTION vocabulary assert (verbs.test:311) — FIXED.** Each exemption key must itself match
  `skipVocabulary`, so a renamed `--force` makes the Set entry a loud failure instead of a silent no-op.
- **Ack-window constant interpolation (attach.test:569) — FIXED.** `tail -c ${ACKS_READ_CAP_BYTES}`; the value
  stays pinned by the drift guard.
- **Drift-guard behaviour (attach.test:575) — FIXED.** The guard now also exercises the real `readBounded` at
  the boundary: exactly `EXEC_MAX_OUTPUT_BYTES` arrives whole and untruncated, one byte over truncates — the
  strict `bytes > cap` semantics the comment promised are now asserted.
- **untilQueued bare newline (attach.test:159) — FIXED.** Requires `raw.trim().length > 0` alongside the
  complete-line count, so a lone flushed newline can't release a wait for one real line.
- **Async `before` await contract (verbs.test:1309/1326) — FALSE POSITIVE.** The runner already does
  `await probe.before?.()` (verbs.test:1746); the promise-returning `pauseRun` is awaited by construction. Left
  as is; the new `after` hook follows the same contract.
- **Duplicated key-set check (verbs.test:411) — FIXED (by removal).** The `every(includes)` line is a logical
  consequence of the filter+toEqual beside it and cannot fail independently; removed, with a comment saying the
  remaining check is the closed shape.
- **KDF pin drop (verbs.test:1366) — FIXED.** `"kdf":"scrypt"` removed from the enrol routing probe's stdout
  pins (the CLI does print it; the primitive just isn't the routing probe's subject). The enrol-vs-record
  spelling of the primitive remains covered by approvers.test.ts's real-writer round trips.
- **messageId ceiling boundary (steering.test:1306) — DEFERRED, out of scope.** `tests/phase-engine/steering.test.ts`
  is not in this fixer's file set.
- **Fold-budget ratio guard (steering.test:969) — DEFERRED, out of scope.** Same file-set reason.
- **Ack-retry third solicitation (steering.test:1020) — DEFERRED, out of scope.** Same file-set reason.

## Summary

- Fixed: 24 (3 HIGH, 8 MED in-scope, 13 LOW in-scope — including 2 "fixed by removal/comment-accuracy")
- False positive: 1 (async `before` await contract — runner already awaits)
- Deferred, out of scope: 4 (vacuous cap-guard test-results, messageId ceiling, fold-budget ratio, ack-retry —
  all in `tests/phase-engine/`, not this fixer's files)

## Source defects found (not edited, per instructions)

1. **`src/fleet/approvers.ts` `enrolApprover` — fresh-host enrolment refuses; docstring contradicts behavior.**
   The header promises the first enrolment on a host (no `.factory/` yet) works; the guarded read's ancestor
   walk stats `.factory`, hits ENOENT, and refuses `approver-allowlist-dir-mode` with a "create … 0700"
   remediation. The operator must hand-create the directory. Now pinned as behavior by a dedicated test;
   flagging so the docstring (or the writer) is corrected deliberately. Repro: `enrolApprover(tmpdir, "alice")`
   on a fresh mkdtemp returns `{ok:false, refusal.code:"approver-allowlist-dir-mode"}`.
