# Wave-2 T3 — unit test hardening report

Files owned and edited (nothing else touched):

- `tests/fleet/approval-gate.test.ts`
- `tests/fleet/approvers.test.ts`
- `tests/providers/run-record.test.ts`
- `tests/phase-engine/steering.test.ts`

**62 new test blocks (73 cases counting `test.each` rows).** No source file was
modified: every implementation break used to prove a test can red was taken from
a byte-exact backup and restored, and the four backups were diffed against the
working tree at the end (all `UNMODIFIED`).

---

## Verdict table

### `tests/fleet/approval-gate.test.ts`

| Finding | Verdict | Note |
|---|---|---|
| [HIGH] `withApprovalLock` — 90 lines of reclamation with no test that can fail | **partly already-covered / rest covered** | The claim is substantially wrong. `tests/reverify/approval.test.ts:146-345` (not one of my files, and not assigned to anyone in wave 2) already drives `withApprovalLock` with hand-written lock files and covers: dead-pid steal, own-live-pid refusal, the atomic rename-claim + "captured a live replacement, restore it" path (via `fs` spies), the `claimed` fail-closed rule, and the fresh-lock timeout throw. What was genuinely unreachable: the **EPERM** arm of `isLockHolderDead`, the new **`LOCK_ABANDON_MS`** escape, the `runId` grammar guard, and lock release on a throwing body. All four now covered. I did not duplicate the four that exist. |
| [HIGH] truncation caps never asserted | **covered** | At cap, cap+1, 8 MB, both `MAX_PROPOSAL_CHARS` and `MAX_REASON_CHARS`; pins "cap INCLUDING the suffix", the current bracketed suffix literal, the absence of a leading `…`, and the lone-surrogate trim (including a JSON round-trip check). |
| [MED] R5-C's third conjunct (`closedAt === undefined`) untested in either direction | **covered** | The teardown-seam half was already pinned by wave 1; I added the **keyHash** half (a closed record with a box and no keyHash still pauses) and a no-box negative control for the seam guard. |
| [MED] no decision against a NONEXISTENT run | **covered** | Pinned as a throw naming the run id, plus "the lock it took on the way in is released, not leaked". See *source defects* below. |
| [MED] the "unknown reportId" test never inspects its decision | **covered (existing test strengthened)** | Now asserts the returned `DecisionOutcome` and the resulting state. Verified: inverting the compare-and-set to `supersededReportIds[0]` reds it (it did **not** red before). |
| [MED] `awaitDecision` + expiry never combined | **covered** | Returns the `timed-out` `RecordedDecision` anchored at `expiresAt`, writes nothing, and its reason/approver match the persisted sweep's byte for byte. |
| [LOW] `expiredState`'s `undefined` / `state: ""` arms | **covered** | Plus the `{}`-shaped entry and `state: ""` with a past `expiresAt`. |
| Wave-1 pins: pausing-resume, different-reportId collision, no-teardown-seam throw, closed-record promote | **already-covered** | Wave 1's four tests verified against `src/fleet/approval-gate.ts` and left alone. |
| Wave-1 pins: rebind restamps `expiresAt`; `submitDecision` validates decision / blank approverId / reserved timeout id; `reportId`/`headSha` trimmed; `supersededReportIds` skips empty, skips the live incoming id, dedupes; `resolveTimeoutMs` ceiling | **covered** | All were unpinned. Added. |
| [MED, filed under run-record] no concurrent-writer case for the `supersededReportIds` read-modify-write | **covered, in this file** | The mechanism is the *gate's* lock, not `RunRecordStore.set`, so it lives here. In one process the two transition bodies are synchronous and cannot interleave — removing the lock leaves an in-process test green — so this is a **two-child-process** test with a shared gate file. |
| [MED, filed under run-record] legacy singular scalar: read → rebind → decide | **covered, in this file** | The store-level fold is already pinned by wave 1 in `run-record.test.ts`; the end-to-end gate path (a pre-DF3.4 record on disk, rebound, then decided against) was not. Added here. |

### `tests/fleet/approvers.test.ts`

| Finding | Verdict | Note |
|---|---|---|
| [HIGH] `authenticateFromStdin` has no test at all | **covered** | 6 tests against a real child process whose fd 0 this process attaches (the live harness's transport). Covers the ok path, the arg-swap regression, the token actually reaching the hash, the `file` 4th positional, the empty-`--approver` short circuit, and the "no token attached" fall-through — that last one with an allowlist that **enrolls the empty token**, so the fall-through *authenticates* instead of merely failing on the hash. |
| [HIGH] the stdin cap is only ever tested with ONE chunk | **covered** | Cumulative over-cap, cumulative exactly-at-cap, and a multi-byte chunk measured in **bytes** not characters. |
| [MED] the fresh-host arm (no `.factory/` at all) is never exercised | **covered** | Asserts the code, that the message names `.factory`, and that the remediation says *create … 0700* rather than *chmod*. |
| [MED] `constantTimeEqual`'s no-length-leak property | **not-possible** | See *not-possible* below. |
| [MED] allowlist schema: `version: z.literal(1)`, `.strict()` × 2, hash regex, BOM | **covered** | v2 refused; extra top-level key refused; extra key on an entry refused; four bad hash shapes (truncated / uppercase / base64 / empty) refused **as schema, never as token-mismatch**; empty salt refused; BOM-prefixed file authenticates. |
| [LOW] reader cancellation on refusal paths | **covered** | Both the too-large and stall paths, via an underlying source with a `cancel()` hook. |
| [LOW] socket child's exit code discarded, `err` never surfaced | **covered (existing test strengthened)** | Non-zero exit now throws naming the code, stdout and stderr. The same discipline is built into the new `authViaStdin` helper. No `kill()` needed — the helper awaits `exited` on every path. |
| [LOW] the `file` parameter is never exercised | **covered** | Twice: through `authenticateApprover` directly and through `authenticateFromStdin`'s 4th positional. |
| [LOW] token trimming asserted for a trailing `\n` only | **covered** | CRLF, leading whitespace, and a trailing blank line. |
| Wave-1 additions (writable ancestor, walk stops at hostRoot, path outside hostRoot, FIFO, empty-id schema, empty/whitespace approverId, trim, case-sensitivity, drip feeder) | **already-covered** | Read and left alone; not duplicated. |

### `tests/providers/run-record.test.ts`

| Finding | Verdict | Note |
|---|---|---|
| [MED] no coverage for a pre-DF3.4 record carrying the legacy scalar | **already-covered (wave 1) + extended in approval-gate.test.ts** | Wave 1's `"a pre-DF3.4 record's singular supersededReportId is FOLDED…"` already covers fold-at-head, drop, `schemaVersion: 2` and idempotence. The read → **rebind** → **decide** half is the gate's, and is in `approval-gate.test.ts`. |
| [MED] no concurrent-writer case | **covered, in approval-gate.test.ts** | See above — the lock under test is the gate's, not the store's. |
| [LOW] no false-positive control for `assertNoSecret` | **covered** | 6 tests: long realistic prose, a multi-line proposal with a path, a single-token all-lowercase >40-char value (this one is what makes `mixedClass` load-bearing), a prose `reason`, a genuinely key-shaped value that must still be refused, and the 39/40 length boundary. |
| Wave-1 pins: `approval.schemaVersion` is 2; over-count `strings` sheds instead of throwing | **already-covered** | Both present and correct; left alone. |
| Wave-1 pin: `assertKind`'s exhaustiveness `never` guard | **not-possible** | See below. |

### `tests/phase-engine/steering.test.ts`

| Finding | Verdict | Note |
|---|---|---|
| [MED] `lastDegradationReason` never observed across two solicitations | **covered** | One instance, drain throws on call 1 and returns `[]` on call 2, asserted after each. Also pins wave 1's **slot separation**: an inbox fault must never write the resident's slot. |
| [MED] an inbox fault and a caller degradation in the SAME solicitation | **covered** | Both fail in one solicitation; each slot holds its own fault and neither holds the other's. A third test covers the reverse order across two solicitations. |
| [MED] "fires once" asserted over exactly ONE solicitation | **covered** | A stable fault fires once across **three** solicitations (kills fire-per-attempt); a **different** fault still fires and is then itself deduped (kills fire-once-then-latch). |
| Wave-1 pin: `onInboxError` is awaited and typed `=> void \| Promise<void>` | **covered** | An async observer that sleeps then throws: the solicitation survives *and* the observer is proven to have completed before `solicit` resolved. |
| Wave-1 pin: 5 s `INBOX_CALL_TIMEOUT_MS` on both `drain` and `ack` | **covered** | Both legs raced in one `Promise.all`, so the suite pays the 5 s once; asserts the elapsed floor/ceiling, both distinct details, and that a hung sidecar leaves `status: "active"`. |
| Wave-1 pin: `messageId` capped in the prompt line | **covered** | A 5 000-char id. |
| Wave-1 pins: drains while degraded; ack retried until it lands; cap after sanitization; `ATTACH_FOLD_CHAR_BUDGET` leaves an over-budget message neither folded nor acked | **already-covered** | Wave 1's tests verified against `src/phase-engine/steering.ts`; left alone. |

---

## Tests verified able to FAIL (implementation broken, test red, break reverted)

Each row: the break applied to the real source, then reverted and diffed byte-for-byte.

| # | Break | Reds |
|---|---|---|
| 1 | `isLockHolderDead`: `return (e as …).code === "ESRCH"` → `return true` (treat EPERM as dead) | `a lock held by a LIVE FOREIGN process (EPERM) is never reclaimed` |
| 2 | `capText`: `text.slice(0, max - suffix.length)` → `text.slice(0, max)` | 4 truncation tests |
| 3 | drop `\|\| age > LOCK_ABANDON_MS` from the reclaim condition | `a lock past the ABANDON age is reclaimed even though its pid still resolves` |
| 4 | delete the lone-surrogate guard in `capText` | `a cut landing INSIDE a surrogate pair drops the orphan` |
| 5 | delete `assertExistingRunId(runId)` from `withApprovalLock` | `the lock path is built from a VALIDATED runId` |
| 6 | drop `rec.closedAt === undefined` from the R5-C keyHash guard | `a CLOSED record with a box and NO keyHash still pauses` |
| 7 | make `withApprovalLock` a pass-through (`return await body()`) | `two rebinds from separate PROCESSES lose neither displaced id` — **red 3 runs out of 3** |
| 8 | `submitDecision`: compare-and-set against `supersededReportIds[0]` instead of `existing.reportId` | `no finish carries a decision against a reportId in NEITHER…` (the strengthened test), + 2 others |
| 9 | `authenticateFromStdin`: swap the `approverId` and `token` arguments | 4 `authenticateFromStdin` tests |
| 10 | `authenticateFromStdin`: fall through on `!read.ok` and authenticate with `""` | `a caller with NO token attached is REFUSED…`, `an attached-but-EMPTY stdin is refused` |
| 11 | `readCappedToken`: `bytes > MAX_TOKEN_BYTES` → `res.value.byteLength > MAX_TOKEN_BYTES` | `MANY under-cap chunks that SUM over the cap`, `a MULTI-BYTE chunk is measured in BYTES` |
| 12 | relax the entry hash schema to `z.string()` | all 4 hash-shape rows |
| 13 | hardcode `DEFAULT_APPROVERS_FILE`, ignoring `file` | both `file`-param tests (+ 2 pre-existing) |
| 14 | delete `await reader.cancel()` | both cancellation tests |
| 15 | narrow `.trim()` to `.replace(/\n$/, "")` | all 3 trimming rows |
| 16 | delete the BOM strip | `a BOM-prefixed allowlist still authenticates` |
| 17 | `version: z.literal(1)` → `z.number()` | `a version-2 file is refused` |
| 18 | drop `.strict()` from `EntrySchema` | `an EXTRA key on an ENTRY is refused` |
| 19 | `assertNoSecret`: drop the `mixedClass` requirement | `a single-token ALL-LOWERCASE proposal … writes` |
| 20 | `assertNoSecret`: drop the charset anchor | 3 prose-proposal tests |
| 21 | `assertNoSecret`: loosen the length bound 40 → 60 | the key-shaped refusal + the 39/40 boundary |
| 22 | `reportInboxFault` writes `lastDegradationReason` (one slot again) | all 3 slot-separation tests (+ 3 wave-1 tests) |
| 23 | delete the `onInboxError` detail dedupe | both "fires once" tests |
| 24 | latch `onInboxError` after the first fire | `a DIFFERENT fault still fires` |
| 25 | drop `withDeadline` from the drain call | `a HUNG drain and a HUNG ack are both bounded…` (hit the 30 s test timeout) |
| 26 | drop the `messageId` slice | `an operator-supplied messageId is CAPPED` |
| 27 | fire `onInboxError` without awaiting it | `an ASYNC onInboxError is AWAITED` |

Two caveats I want on the record, both noted in the test comments:

- **#1 (EPERM)** discriminates only when the suite is **not** run as root. Under
  root, `process.kill(1, 0)` succeeds and the test passes for the other reason
  (holder alive), so it stops being a detector for that specific break. It never
  produces a false failure. There is no portable pid that is EPERM for root.
- **#7 (cross-process rebind)** is deterministic when the implementation is
  correct; as a regression detector it is a real race, so its redness is
  probabilistic. Observed red 3/3 with the lock removed.

## Not possible (reported, not attempted)

1. **`constantTimeEqual`'s no-length-leak property.** The finding says replacing
   the body with `a.length === b.length && timingSafeEqual(...)` or plain
   `a === b` "keeps them green". That is true and I could not fix it honestly.
   `a === b` is behaviourally indistinguishable from digest-then-compare on every
   input a test can supply (barring a sha256 collision), so only a **timing**
   harness could catch it — and a timing assertion in this suite would be flaky
   and would fail on a loaded CI box. There is one input class that does
   distinguish them (lone surrogates, which `createHash().update(s, "utf8")`
   folds to U+FFFD, so `constantTimeEqual("\uD800", "�")` is `true` while
   `===` is `false`) — I deliberately did **not** pin that: it is a UTF-8
   encoding artifact, not the security property, and pinning it as *desired*
   would red on any legitimate rewrite to a proper constant-time byte compare.
   Note also that `constantTimeEqual` is not length-independent in *total* time
   anyway — the sha256 of a long input costs more than of a short one; the
   property is only about the comparison step.
2. **`assertKind`'s exhaustiveness `never` guard.** Compile-time only, and
   `assertKind` is not exported, so there is no runtime call that can reach the
   `unhandled: never` line without a fifth `FieldKind` existing — at which point
   `tsc` is the assertion. `bunx tsc --noEmit` is the test.
3. **The `claimed` fail-closed rule and the live-replacement restore.** Already
   covered in `tests/reverify/approval.test.ts` via `spyOn(fs, …)`; not a gap and
   not duplicated.

## Source defects found, NOT fixed

1. **`submitDecision` against a nonexistent run throws a raw storage error.**
   `readApproval` → `store.get` does not catch ENOENT (unlike
   `readApprovalIfPresent`), so a typo'd run id — the most ordinary operator
   error on this verb — surfaces as
   `unreadable run record run-typo.json: ENOENT` rather than a classified
   refusal like the `{ outcome: "not-decidable", state: "absent" }` an
   *existing* run with no approval namespace gets. I **pinned the current
   behaviour** (it throws, and it names the run id, and the lock it took is
   released) rather than changing source. Two readers in one module with
   deliberately different ENOENT postures is at minimum worth a comment; if the
   CLI layer already maps this to a usable exit code and remediation, the gap is
   cosmetic — I did not verify the CLI side, it is another agent's file.
2. **Reviewer finding T3-HIGH-1 is substantially inaccurate.** `withApprovalLock`
   was *not* untested; five of its arms are covered in `tests/reverify/approval.test.ts`.
   Worth correcting in the ledger so the same claim is not re-raised.

---

## Verbatim output

```
=== bun test (focal, 4 suites) ===
bun test v1.4.0 (34cbb9a40)
run-record: extensions.approval.supersededReportIds reached the 256-element bound; dropping the 1 oldest

 333 pass
 0 fail
 1070 expect() calls
Ran 333 tests across 4 files. [57.82s]

=== bunx biome check --write (my 4 files) ===
Checked 4 files in 108ms. No fixes applied.

=== bunx tsc --noEmit (whole project) ===
tsc exit: 0
```

`bunx tsc --noEmit` is clean project-wide — no errors in any file, mine or
anyone else's, at the moment of this run. No re-run was needed for contention;
the focal suite passed first time.

Source files confirmed unmodified after all 27 break/revert cycles:

```
UNMODIFIED  src/fleet/approval-gate.ts
UNMODIFIED  src/fleet/approvers.ts
UNMODIFIED  src/providers/run-record.ts
UNMODIFIED  src/phase-engine/steering.ts
```
