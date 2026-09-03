# Edge Case Review — T1/T2 Live E2E Tests

## Confirmed Findings

### [BLOCKER] finally-id-recovery regex mismatch — tier2-dispatch-engine.live.test.ts:629-632 — trigger: gate-refused dispatch with NO runId in streams → wrong outcome (leaked box)

**Context**: The test's finally block attempts to recover `runId` and `vmName` from `dispatchOut` and `dispatchErr` when they are empty (e.g., gate refusal). The recovery patterns are:
- runId: `/qds-[0-9]{8}-[a-z0-9]{6}/`
- vmName: `/ssh ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})\.exe\.xyz/` or `/(?:teardown|rm) ((?:qds|e2e)-[0-9]{8}-[a-z0-9]{6})/`

**Trigger**: When dispatch is refused at the gate (F12 lesson context), the test comment says "emitted a REFUSAL payload, not an ack — so `runId` above stayed ''". But the recovery assumes the refusal stream contains a `qds-` prefixed runId matching the grammar from `src/providers/run-record.ts`.

**Issue**: The actual runId generation pattern per `src/providers/run-record.ts` (line 221) is `RUN_ID_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/` with 63-char max. Dispatch-generated IDs follow `newId()` which produces `<slug>-<YYYYMMDD>-<6 hex>`. However, the regex `/qds-[0-9]{8}-[a-z0-9]{6}/` assumes EXACTLY 8 digits and 6 hex chars. If the generated ID varies (e.g., different timestamp format, nonce variations), the regex fails to match.

**Verification**: `src/providers/run-record.ts` shows the `newId()` function produces IDs via the RNG factory, but the exact pattern in dispatch ack payloads should be verified against actual `src/fleet/dispatch.ts` output. The recovery regex is too specific.

**Wrong outcome**: A leaked box — if the recovery fails to extract IDs, the subsequent `runFleet(["teardown", ...])` and `destroyQuietly` calls skip cleanup, leaving a billable VM.

---

### [HIGH] tier1-lock.live.test.ts race condition — tier1-lock.live.test.ts:519-522 — trigger: teardown subprocesses finish simultaneously but both exit 0 → wrong outcome (no refusal proven)

**Context**: The test spawns two `fleet teardown` subprocesses concurrently to prove exactly one wins (exit 0 or 6) and the other refuses (exit 5 with "run-locked").

**Trigger**: The per-run lock mechanism in `scripts/lib/run-lock.ts` (line 141) uses `isAlive(pid)` via `process.kill(pid, 0)` to determine holder liveness. On a FAST teardown where the first subprocess acquires, performs teardown, AND releases before the second subprocess's lock claim even reads the file, BOTH may see an unlocked lock and proceed.

**Issue**: The test asserts:
```typescript
expect([0, 6]).toContain(winner.exitCode ?? -1);
expect(loser.exitCode).toBe(5);
expect(loser.stderr).toContain("run-locked");
```

But if both finish before the lock claim is evaluated, both could exit 0 (or 6 if no key was minted). The lock's pid namespace handling (`/proc/self/ns/pid` on Linux, line 108) prevents host-level false positives, but the in-process race remains.

**Verification**: `scripts/lib/run-lock.ts` shows the lock acquisition reads the file, parses pid/hostTag, and calls `isAlive`. If the first process fully completes (including release via link/unlink at line ~400) before the second reads, no lock exists.

**Wrong outcome**: The test fails with both exit codes 0/6, proving no serialization occurred, but the test assumes one MUST refuse.

---

### [MEDIUM] tier1-fanout-refusal.live.test.ts false-negative verification — tier1-fanout-refusal.live.test.ts:199-206 — trigger: fanout verb fails to spawn arms but list() still shows boxes → wrong outcome (test passes but INV-2 violated)

**Context**: The test holds a `FleetLock` at `.sandbox/fleet.lock`, then runs `fleet fanout` expecting refusal exit 5 and "mutated nothing" — verified by checking no new boxes in `driver.list()` and no records written.

**Trigger**: The `fleet fanout` verb is spawned as a subprocess via `runFleet` (line 183-190). The lock is held at `join(workspace, ".sandbox/fleet.lock")`. If the fanout verb internally retries or the lock acquisition races with the subprocess spawn timing, one arm MAY provision before hitting the lock check.

**Issue**: The verification at lines 199-206 checks `after.length === before.length` and `runRecords === []`. But the test only checks the PROVIDER list, not the transient lock acquisition window. If `fanout`'s internal lock check races with `lock.release()` in finally (line 214), the test could pass even if a box was briefly created.

**Verification**: The lock release at line 214 `lock?.release({ force: true })` occurs in finally, AFTER the fanout verb completes. The verb should have checked the lock synchronously. But `FleetLock.acquire()` in `src/fleet/fleet-lock.ts` has a retry loop and stale detection.

**Wrong outcome**: False-negative pass — the test reports success but INV-2 "a refused fan-out mutates nothing" may have been briefly violated during the race window.

---

### [MEDIUM] tier2-fanout-bestofn.live.test.ts arm-leak in finally when fanout fails early — tier2-fanout-bestofn.live.test.ts:938-953 — trigger: fanout verb fails before emitting arm lines → wrong outcome (armRunIds/armVms empty, no teardown)

**Context**: The test runs `fleet fanout` expecting 2 arm records. In the finally block, if `armRunIds.length === 0 || armVms.length === 0`, it attempts ID recovery via regex over `fanOut` and `fanErr`.

**Trigger**: If the fanout verb crashes during provisioning (e.g., provider error during arm 0's box creation) before emitting the JSON arm lines, both `armRunIds` and `armVms` remain empty. The recovery regex `/qds-.../` (same issue as finding #1) may fail to match any IDs in the output.

**Issue**: The finally teardown loop at lines 945-951 iterates `for (let i = 0; i < armRunIds.length; i++)`. If recovery fails, `armRunIds` stays empty and NO teardown verbs are called. A second loop calls `destroyQuietly` for each `vm`, but if `armVms` is also empty, no direct destroy occurs.

**Verification**: The test comment at line 936 mentions "Same lessons as T2.1's finally (F12/F13)" — this indicates the recovery pattern was copied from T2.1 but may share the same regex fragility.

**Wrong outcome**: Leaked boxes — if fanout fails mid-provision after boxes are created but before JSON output, the finally block cannot recover and cannot tear down.

---

### [MEDIUM] tier1-teardown.live.test.ts key leak on early failure — tier1-teardown.live.test.ts:742-745 — trigger: mint succeeds but teardown verb fails before revoke → wrong outcome (key remains on provider)

**Context**: The test mints a real key via `mintCappedKey` (line 743), then calls `fleet teardown` verb (line 748) expecting revoke as part of the chain.

**Trigger**: If `teardown` verb fails AFTER mint but BEFORE the revoke step (e.g., harvest error, box destroy timeout), the finally block at line 794-802 only checks for box cleanup via `ctx.driver.list(runId)`. It does NOT attempt to revoke the key directly if the verb failed mid-chain.

**Issue**: The test only has one key verification: `expect(await listedKeyHashes().then((s) => s.has(hash))).toBeFalse();` at line 758, which runs AFTER a successful teardown. If teardown fails, that check never runs. The finally block has no `listedKeyHashes().then(...).catch()` revoke fallback.

**Verification**: The finally comment at line 792-793 acknowledges "If anything above failed mid-chain the key may still be live" but only attempts destroy, not revoke.

**Wrong outcome**: Leaked OpenRouter key — the key remains valid on the provider, incurring spend if ever used, with no test assertion to detect it.

---

### [LOW] tier2-dispatch-engine.live.test.ts pi retry storm — tier2-dispatch-engine.live.test.ts:526-535 — trigger: first pi attempt times out, second attempt ALSO times out → wrong outcome (test hangs then throws generic timeout)

**Context**: The test runs `pi` via `ctx.driver.execTimed` with a 540s timeout. If the first attempt stalls (observed "fresh-box pi stalls"), it retries once after 30s sleep.

**Trigger**: The retry at line 533 `await new Promise((r) => setTimeout(r, 30_000)); engine = await runPi(); attempt = 2;` has no additional timeout. If the first attempt timed out at 480s (the `timeout 480` in the shell command), and the retry ALSO stalls, the total elapsed time can exceed the test's 1,800s timeout.

**Issue**: The retry does NOT reset the driver-level timeout. If `execTimed`'s outer timeout is 540s, and the first attempt took 479s, the retry has only ~61s remaining before the outer timeout fires. The test would then throw "runFleet timeout after 540 ms" (or similar), losing the distinction between pi timeout vs. harness timeout.

**Verification**: The pi command at line 525 has `timeout 480` (shell-side), wrapped by `execTimed(..., 540_000)` (driver-side). If both fire, the race between them produces unclear diagnostics.

**Wrong outcome**: Flaky test — intermittent failures on slow substrate with poor diagnostics distinguishing pi stall vs. harness timeout.

---

### [INFO] tier1-harvest.live.test.ts workspace cleanup on fill failure — tier1-harvest.live.test.ts:342-387 — trigger: fill fails after record created but before box destroyed → wrong outcome (workspace persists but harmless)

**Context**: T1.3a creates a run record, boxes it, fills it. If fill fails (line 354), the test goes to finally and calls `teardown` verb (line 379), then removes workspace (line 386).

**Trigger**: If `teardown` verb ITSELF fails (e.g., provider unreachable), the workspace cleanup at line 386 still runs. The `rmSync(workspace, { recursive: true, force: true })` succeeds regardless of teardown state.

**Issue**: This is actually CORRECT — workspace cleanup should happen regardless. The test's `finally` structure is sound. This is only informational to confirm the behavior.

**Verification**: `rmSync` with `force: true` ignores ENOENT and recursively deletes. The only risk is if workspace path is somehow malformed, but `tmpWorkspace` uses `mkdtempSync` which guarantees a valid directory.

**Wrong outcome**: None — this path is correctly handled.

---

## NO FINDINGS

The following areas were examined and found robust:

- **liveGate gating** (live-harness.ts:56-75) — correctly throws on tier mismatch or missing env vars, never silently skips.
- **Secret scrubbing** (live-harness.ts:130-172) — `writeEvidence` scrubs both `sk-or-...` patterns and env var values, then ASSERTS no secrets remain before writing.
- **runIdFor collision resistance** (live-harness.ts:119-126) — uses timestamp + random nonce, validates grammar and length before returning.
- **destroyQuietly best-effort** (live-harness.ts:299-306) — catches errors and logs them rather than masking test failure, correct discipline.
- **T2.1 box-hour ledger verification** (tier2-dispatch-engine.live.test.ts:600-606) — correctly asserts fractional µ$ row priced (unpriced=0) post-F8 fix.
- **Tier2 aggregate ceiling** (tier2-fanout-bestofn.live.test.ts:759-765) — correctly sets perIssueOverrides to 2×per-arm cap so both arms can admit against the shared issueId.

## Summary

- **BLOCKER**: 1 (regex-based ID recovery failure → box leak)
- **HIGH**: 1 (lock test race → false positive test failure)
- **MEDIUM**: 3 (fanout refusal false-negative, fanout arm leak, teardown key leak)
- **LOW**: 1 (pi retry diagnostic ambiguity)
- **INFO**: 1 (confirmed correct behavior)
