# Fix wave — cluster A (gate) report

Files owned: `src/fleet/approval-gate.ts`, `tests/fleet/approval-gate.test.ts`. Nothing committed.

## Verdict table

| # | Sev | Verdict | Evidence |
|---|-----|---------|----------|
| 1 | HIGH | **fixed** | Acquire-side restore is now `renameSync(claimPath, lockPath)` (atomic, inode-preserving) with an `existsSync` guard when a new holder re-took the path; no `wx` rewrite, so no vacancy window and no fresh inode for B's fenced release to miss. Same fail-closed error message kept. `src/fleet/approval-gate.ts:257-287`. **Breaks one cluster-G test seam — see cross-cluster notes.** |
| 2 | HIGH (gate half) | **fixed** | Resume arm now (a) restamps `requestedAt`/`expiresAt` together under the lock before `promote: true` (same both-fields pattern as the rebind), and (b) runs `assertBundlePresent(deps, runId, "resume")` before that write. `src/fleet/approval-gate.ts:899-916`. |
| 13 | LOW | **fixed** (folded into #2) | Same edit; new test "a RESUME is refused when the run's harvested bundle is gone" pins it, byte-identical on refusal. |
| 14 | LOW | **fixed** | New union arm `{ outcome: "changed" } & ApprovalLockInfo`: successor-replaced lock now reports `changed` (with the inspected holder's info); only a genuine ENOENT-vanish reports `absent`. `reclaimApprovalLock`, `approval-gate.ts:518-534`. CLI exit behavior unchanged (only `refused` exits 5). |
| 15 | LOW | **fixed** | The EEXIST-branch catch now swallows only `code === "ENOENT"`; EACCES/EMFILE/etc. propagate instead of being misreported as "held for over 5000ms". `approval-gate.ts:289-296`. |
| 16 | LOW | **fixed** | `awaitDecision` clamps `pollMs`: non-finite → 1000 default, otherwise `Math.max(pollMs, LOCK_POLL_MS)` (10 ms floor), mirroring `resolveTimeoutMs`'s clamped-not-refused posture. `approval-gate.ts:1425-1432`. |
| 17 | LOW | **fixed** | New `withTeardownClaim` (`approval-gate.ts:1118-1188`): per-run `<runId>.teardown.claim` file, `wx` create, live-holder waits and then runs its own (idempotent) teardown, dead/unparseable-holder claim reclaimed (graceful degradation to pre-claim behavior, never worse), content-fenced release. New in-process test proves `maxInFlight === 1` for two concurrent same-reportId resumes. Residual documented in-code: wait on a live holder is unbounded (a hung teardown hangs the resume — it already hung the holder), and the claim has no operator verb (reclaim is safe here precisely because a wrong reclaim only re-opens the old race, unlike the approval lock). |
| 18 | LOW | **fixed** | `writeTimeout` now takes the extension and stamps `decidedAt = ext.expiresAt` — the same anchor `derivedTimeout` reports. Both callers (`submitDecision`, `sweepExpired`) updated. **Behavior change, flagged below.** |
| 28 | MED | **fixed** | Module-scope `pid1Probe` captures `kill(1, 0)`'s error once; test is `test.skipIf(pid1Probe !== "EPERM")` with a loud `console.error` at load when skipped, and asserts `pid1Probe === "EPERM"` as its first line when it runs. |
| 29 | MED | **fixed** | All four hand-built `pausing` fixtures now carry `requestedAt`/`expiresAt`/`supersededReportIds` (schemaVersion is store-stamped). Resume test uses a long-past window + fixed `now` and asserts restamped `requestedAt` and `expiresAt = now + DEFAULT_TIMEOUT_MS` after promotion. |
| 30 | MED | **fixed** | Shared `ERROR_LINE_KEYS` (13 keys, sorted); both error-path tests ("a throw still emits", INV-APPROVE-6 refusal) now pin `Object.keys(line).sort()` — an added `error: err.message` key reds the test. |
| 31 | MED | **fixed (strengthened + documented)** | Seam analysis in the test comment: the critical section is fully synchronous, so no deterministic yield injection is possible without a test-only production seam. Instead: per-child ready files replace the fixed `Bun.sleep(400)` (gate released only after ALL four children are parked), and 4 racers (4! interleavings to expose a lost update) instead of 2. Asserts all 5 ids recoverable, `supersededReportIds` length 4. |
| 32 | LOW | **fixed** | Byte-identity record assertions added to the report-changed refusal and the bundle-gone rebind refusal. |
| 33 | LOW | **fixed** | `expect(line.duration).toBe(Number(line.durationMs))` removed; `durationMs` is now anchored to real elapsed time (`>= 0`, `<=` wall time measured around the call), matching the `teardown_at_pause_ms` pin's approach. |

## gitnexus impact (run before editing exported symbols)

- `withApprovalLock` — risk LOW, 3 direct callers (`requestApproval`, `submitDecision` in-module; `run` in scripts/fleet.ts), 2 processes.
- `requestApproval` (approval-gate.ts) — risk LOW, 1 direct caller (`src/reverify/approval.ts`); 4 other same-named symbols exist, disambiguated by uid.
- `awaitDecision` — risk LOW. `sweepExpired`, `submitDecision` — risk LOW, direct caller `run` (scripts/fleet.ts).
- `reclaimApprovalLock` — "Target not found": the index is stale for this symbol (noted; impact assessed by grep instead — only consumer is scripts/fleet.ts:2786).

## Behavior-change flags (for the re-pin wave)

1. **Persisted timeout `decidedAt`** is now the expiry instant (`expiresAt`), not notice-time (#18). Any consumer comparing persisted vs derived timeouts now sees agreement.
2. **`reclaimApprovalLock` new outcome `changed`** (#14). scripts/fleet.ts compiles unchanged and exit codes are unchanged (0), BUT `GATE_OK_OUTCOMES` (scripts/fleet.ts:2417, cluster F) does not contain `"changed"`, so the unlock gateEvent for this rare outcome logs `status: "error"` on an exit-0 invocation. Cluster F may want to add `"changed"` to that set.
3. **Resume restamps `requestedAt`/`expiresAt`** (#2a) — a resumed run's window now starts at the resume, never inherits the dead one.
4. **Resume requires the bundle when `bundleDir` is set** (#2b/#13) — previously an unchecked route to the decidable state.
5. **Concurrent resumes serialize teardown** via a `<runId>.teardown.claim` file in the runs dir (#17). All runs-dir scans filter by extension/prefix (verified: run-record, fanout, reaper, status) and ignore it. `teardown_at_pause_ms` now includes claim wait.
6. **`awaitDecision` floors `pollMs` at 10 ms** (#16); non-ENOENT filesystem faults during lock acquisition now throw immediately instead of "held for over 5000ms" (#15).

## Cross-cluster notes

- **Cluster G — action needed.** `tests/reverify/approval.test.ts:236` ("a restore failure after a successful claim fails closed, not open") fails after fix #1: its failure injection spies `writeFileSync(lock, …)`, a call the restore path no longer makes (restore is now the atomic rename-back — that is the fix). The fail-closed contract and error message (`approval lock reclaim: failed to restore …`, claim file preserved) are unchanged; the test only needs its injection seam moved from `writeFileSync` to the SECOND `renameSync` (the restore rename `claimPath → lockPath`, e.g. throw EIO on the second rename call after `pastRename`). Verified the failure is exactly this seam: received "held for over 5000ms" because the rename-back succeeded and the replacement lock (live pid) was correctly restored. Its sibling test ("a replacement lock racing in between… is NOT destroyed") passes unmodified and now also exercises the inode-preserving restore.
- **Cluster G** also owns the runner half of #2 (re-present bound reportId) — gate side is ready and tested with fixtures that carry the production shape.
- **Cluster F**: see flag 2 above (`GATE_OK_OUTCOMES`).

## Verification

- `bun test tests/fleet/approval-gate.test.ts` → **95 pass, 0 fail** (exit 0), incl. all new/rewritten tests. EPERM test ran (non-root macOS host).
- `bunx tsc --noEmit` → **0 errors**.
- `bunx biome check src/fleet/approval-gate.ts tests/fleet/approval-gate.test.ts` → **clean**.
- `bun test tests/reverify/approval.test.ts` (not my file, checked for blast radius) → 15 pass, 1 fail — the cluster-G seam documented above; reproduced and root-caused to my #1 change by design.
