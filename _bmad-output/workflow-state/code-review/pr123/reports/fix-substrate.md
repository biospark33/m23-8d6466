# W1f — driver / gates / step-log fixes (round 10, PR 123)

Fixer: W1f. Branch `feature/df3-2-fanout-best-of-n`. No commits/pushes made.

## Risk warning (per repo CLAUDE.md)

GitNexus upstream impact before each edit:

| Symbol | Risk | Direct callers |
|---|---|---|
| `provisionAdmittedRun` (driver.ts) | **CRITICAL** | dispatch, createRun; flows into fanout, fleet run, cap-hit-demo |
| `address` (driver.ts) | **HIGH** | provisionAdmittedRun only |
| `isSubstrateFailure` (fake-gate.ts) | **HIGH** | dispatch (+ fanout classification path) |
| `driverListing`, `unverifiedVmListingRefusal` | **HIGH** | reapRuns, reaper sweep, sandbox-reap |
| `substrateFailure` | LOW | fakeGate probes |

Every change is failure-path-only or format-only; happy-path values are unchanged. All listed suites pass after the edits.

## Dispositions

### FB1 MED — FIXED. Mid-sequence `store.set` failures now classified
`src/providers/driver.ts` (`provisionAdmittedRun`): both previously-raw writes — the vmName/ports/httpsUrl write and the post-expose httpsUrl confirm — go through one local helper `setRecord(patch, what)` that rethrows as `ProvisionRefusedError("record-write-failed", …)` with the underlying message and a teardown remediation, so `providerCodePayload` in dispatch sees `providerCode: "record-write-failed"`.
Deliberate non-change: no rollback on these sites (unlike the budget-write path above them). The box already exists when these writes run; removing the record would orphan live spend. The open record naming the box stays the cleanup handle.

### FB2 MED — FIXED. `address()` null/non-string + trimming
`src/providers/driver.ts`: signature is now `(url: unknown, source: string, runId: string)`.
- `undefined` → absent (unchanged); empty/whitespace-only → absent (unchanged).
- `null` / any non-string → `ProvisionRefusedError("driver-address-invalid", …)` naming which call resolved what, remediation points at teardown. Previously a raw `TypeError` out of `.trim()`, escaping before `vmName` was recorded on the create path.
- A padded URL is now returned TRIMMED (behavior change, see below).

### FB3 MED — FIXED. `isSubstrateFailure` survives junk from an injected gate
`src/providers/fake-gate.ts`: reads `assertions` through an `Array.isArray` guard (junk ⇒ `false`) and narrows each element for null before reading `.ok`/`.note`. Semantics for well-formed gates identical (`!a.ok && typeof note === "string" && note.includes(SUBSTRATE_MARK)`). Fail-closed direction preserved: unknown ⇒ "do not advertise a retry".

### FB4 MED — FIXED. Negative exit codes substrate-marked
`src/providers/fake-gate.ts` (`substrateFailure`): new arm after the null arm — negative number ⇒ `${SUBSTRATE_MARK}… killed by signal ${-exitCode} …`. A signaled probe (-15 spawn convention) can no longer fall through to a do-not-retry manifest verdict. Existing arms untouched.

### FB5 LOW — FIXED. Structured skip entry for the no-anomaly-channel fallback
`src/providers/driver.ts`: `driverListing`'s fallback emits `noAnomalyChannelSkip(name)` = `` `unproven-listing driver=<name> reason=no-anomaly-channel (no listWithAnomalies)` `` instead of a prose sentence; guidance in `unverifiedVmListingRefusal` gained a sentence telling the operator an `unproven-listing` entry is not a box (implement the channel or switch drivers). Type stays `skipped: string[]`, so reaper.ts/exedev/fake-driver consumers need no edits (verified: reaper only checks `.length` and passes entries verbatim).

### FB6 LOW — FIXED. displayName escapes Cf/Zl/Zp
`src/providers/fake-driver.ts`: escape set extended past C0+DEL to U+00AD, U+0600–0605, U+061C, U+06DD, U+070F, U+08E2, U+180E, U+200B–200F, U+2028–202E (Zl/Zp/bidi incl. U+202E RTL override), U+2060–2064, U+2066–206F, U+FEFF, U+FFF9–FFFB. Ordinary names still pass byte-for-byte; existing S19 pin (`bad\tname` → `bad	name`) unchanged and passing.

### FB12 LOW — FIXED. Item C distinguishes wrong-TYPE `.env`
`src/providers/fake-gate.ts` item C probe adds `[ ! -f .env ] → echo not-a-file`; handler returns `".env exists but is not a regular file — re-run the key delivery step; do not chmod"` (delivery-contract class, same as absent). Race/unreadable arm keeps SUBSTRATE_MARK exactly as before. Mode-mismatch detail now only reachable for regular files.

### FB9 LOW — FIXED (test only). Two-sided lock-timeout pin
`tests/providers/run-record.test.ts`: ONE appended top-level test. Side B triggers the REAL throw path (unreadable lock body ⇒ full LOCK_TIMEOUT_MS wait ⇒ throw), asserts the message prefix; Side A asserts `isRecordLockTimeout` accepts that exact message and rejects rewordings plus a non-Error carrying the right text.
Support edit in MY file: exported `isRecordLockTimeout` from `src/providers/driver.ts` (was module-private). No constant extracted — run-record.ts's throw site is another agent's file, so the test pins the literal shape with a comment explaining why.

### DEFERRED (untouched, per instruction): FB7, FB8, FB10. DISMISSED: FB11.

## Behavior changes flagged

1. Padded URLs recorded/returned trimmed (FB2): a driver resolving `"  https://x  "` now lands `https://x` on the record and in `ProvisionedRun.httpsUrl`.
2. Driver contract violations mid-provision are now classified refusals, not crashes: `null`/non-string URL ⇒ exit payload carries `providerCode: "driver-address-invalid"` + remediation instead of an unclassified TypeError (FB2); failed record writes ⇒ `providerCode: "record-write-failed"` instead of raw errno Error (FB1).
3. Gate classification: negative exit codes and junk injected-gate shapes can no longer produce a manifest-verdict / classifier-crash respectively (FB3/FB4) — strictly toward more retryable-substrate marks, never fewer.
4. Reap refusal message/count text changes when the fallback fires (FB5): "1 listing entry (unproven-listing driver=fake reason=…)" replaces the prose sentence. Any test or operator script grepping the old sentence must switch to the `unproven-listing` tag (none found in tests).

## Coordination notes for other agents

- `tests/providers/run-record.test.ts`: I touched ONLY the driver.ts import line (added `isRecordLockTimeout`) and appended one test at EOF. Suite ran 83 pass / 0 fail including my pin.
- `bunx tsc --noEmit` currently reports ONE error in `scripts/lib/run-lock.ts(413,9)` (read-only `remediation` assignment) — that file is modified in the working tree by another owner (scripts/*), not by me. No errors in any file I touched.
- One exedev suite run had a single transient fail that did not reproduce across two clean reruns (149 pass / 0 fail final); my changes touch nothing under exedev.

## Commands and results

```
bunx biome check src/providers/driver.ts src/providers/fake-driver.ts src/providers/fake-gate.ts tests/providers/run-record.test.ts
  → Checked 4 files. No errors. (one iteration needed: biome-ignore moved adjacent to the regex literal)

bunx tsc --noEmit
  → only scripts/lib/run-lock.ts(413,9) — another agent's in-flight file; none in my files

bun test tests/providers/driver-contract.test.ts tests/providers/fake-driver.test.ts tests/providers/step-log.test.ts
  → 71 pass, 0 fail

bun test tests/providers/exedev/
  → 149 pass, 1 todo, 0 fail (final run; see transient note above)

bun test tests/providers/run-record.test.ts
  → 83 pass, 0 fail (includes new FB9 pin)

mcp detect_changes(scope=unstaged)
  → my changed symbols confined to driverListing/address/provisionAdmittedRun/createRun/assertAdmissionNotDelegated/unownedVmReapRefusal (file-level attribution), displayName/FakeDriver, substrateFailure/fakeGate; all other changed files belong to parallel fixers
```

Files touched (all absolute):
- `/Users/steve/QDS-Factory/src/providers/driver.ts` (FB1, FB2, FB5, export for FB9)
- `/Users/steve/QDS-Factory/src/providers/fake-driver.ts` (FB6)
- `/Users/steve/QDS-Factory/src/providers/fake-gate.ts` (FB3, FB4, FB12)
- `/Users/steve/QDS-Factory/tests/providers/run-record.test.ts` (FB9 pin only)
