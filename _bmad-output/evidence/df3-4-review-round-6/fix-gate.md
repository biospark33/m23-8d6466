# F1 — `src/fleet/approval-gate.ts`, `src/reverify/approval.ts`

Owned files touched:

- `/Users/steve/QDS-Factory/src/fleet/approval-gate.ts`
- `/Users/steve/QDS-Factory/src/reverify/approval.ts`
- `/Users/steve/QDS-Factory/tests/fleet/approval-gate.test.ts` (4 new tests — the two
  resolutions that explicitly asked for one, plus their negative controls)

No other file edited. No commit, no push, no full suite run.

## Verdict table

| # | Verdict | Note |
|---|---------|------|
| 1 [BLOCKER] | fixed | Second refusal after R5-C: open record + `vmName` + no `deps.teardown` ⇒ throw naming run, box and the missing seam. `pausing` stands, run recoverable. 2 tests. |
| 2 [HIGH] | fixed | `pausing` whose bound `reportId` equals the incoming one now RESUMES (re-run teardown → promote via the existing tail). A different `reportId` still returns `pause-in-progress` byte-identically. Both guards apply on the resume path. 2 tests. |
| 3 [MED] | fixed | `awaitDecision` routes through `expiredState`; a derived expiry returns a `timed-out` `RecordedDecision` stamped at `expiresAt` (the expiry instant), not `null`. |
| 4 [MED] | fixed | `expiresAt` hoisted next to `requestedAt` and written on BOTH the fresh and the rebind path. |
| 5 [MED] | fixed | `resolveTimeoutMs` clamps at both ends; new exported `MAX_TIMEOUT_MS = 365d`. |
| 6 [MED] | fixed | `assertExistingRunId(runId)` at the top of `withApprovalLock` (reused, not a new regex — same grammar every record read enforces, so no id that can reach a record is refused). |
| 7 [MED] | fixed | `submitDecision` validates `decision ∈ {approved, rejected}` and rejects a blank `approverId`, both before the lock and before any write. |
| 8 [MED] | fixed | `submitDecision` refuses `approverId === TIMEOUT_APPROVER_ID`. |
| 9 [LOW] | fixed | Both reclaim `continue`s removed (restructured to `if (claimed)`); every path now reaches the deadline check and the `Bun.sleep`. |
| 10 [LOW] | fixed | `LOCK_ABANDON_MS = 1h` escape reclaims regardless of pid liveness; tradeoff commented. Chosen well above the 60 s backdating the three existing lock tests use, so their "not reclaimed by age alone" property still holds. |
| 11 [LOW] | fixed | `supersededReportIds` skips empty, skips the incoming id, dedupes. No cap added (see BEHAVIOR CHANGES / not-done). |
| 12 [LOW] | fixed | `headSha` echo goes through `String(… ?? "")`; both `reportId` and `headSha` are trimmed before validation and before binding. |
| 13 [LOW] | fixed | `capText` drops a trailing lone high surrogate after the slice. |
| 14 [LOW] | **deferred** | True as stated, harm not demonstrated — see below. |
| 15 [LOW] | fixed | Bundle-existence guard extracted to `assertBundlePresent` and called on the first request as well as the rebind. Terminal / `pause-in-progress` branches deliberately still skip it. |
| 16 [LOW] | fixed (approverId) | Blank `approverId` refused. Blank `reason` intentionally still accepted — DF5.2's `approval-incomplete` (push.ts:270) checks `approverId`/`decidedAt` only, so a blank reason is a weak audit entry, not an unrecoverable record. Flagged, not silently dropped. |
| 17 [LOW] | fixed (doc) | Signature unchanged (existing callers untouched, as instructed); the doc now states precisely what the default buys and that finding 1 makes it safe by refusal rather than by assumption. |
| 18 [LOW] | fixed | Suffix is now the spec's literal `[truncated, N chars total]`; the undeclared leading U+2026 is gone. |

**17 fixed, 1 deferred, 0 false positives.**

### #14 — deferred, with reasoning

The observation is factually correct: `requestApproval` returns
`{outcome:"already-decided", state}` and `submitDecision` returns that plus
`approverId`/`decidedAt`/`reason`. But these are two distinct exported types —
`ApprovalOutcome` (DF5.1-owned, `src/reverify/approval.ts:35`) and
`DecisionOutcome` (gate-owned) — and nothing in the repo unions them: `runner.ts`
consumes only the former (through `ReverifyOutcome["approval"]`),
`scripts/fleet.ts` imports only the latter. TypeScript prevents the `undefined`
access the finding describes, because no value ever has both shapes. Making them
identical means widening a DF5.1-owned public type and changing what
`ReverifyOutcome` carries, which is a spec change to another story's surface for
a hypothetical caller. Enriching it is a two-line change if the team wants the
uniformity — say so and I'll do it.

## BEHAVIOR CHANGES (for the wave-2 test pass)

1. **`requestApproval` on a `pausing` record with a MATCHING `reportId` now returns
   `{outcome:"requested"}`, re-runs `teardown`, and promotes** — it used to return
   `{outcome:"pause-in-progress"}` and write nothing. A non-matching `reportId` is
   unchanged. DF5.1's `approval-pause-in-progress` flag now fires only on the
   genuine collision.
2. **`requestApproval` throws when the record is open, names a `vmName`, and
   `deps.teardown` is absent.** The `pausing` extension is already on disk when it
   throws. Reachable today from `recordApprovalPort(store)` — i.e. `runner.ts:406`
   — for any run whose record was never closed. Message matches `/no teardown seam/`.
3. **A rebind now restamps `expiresAt`.** A rebound report gets a full fresh
   window instead of the remainder of the original one.
4. **`awaitDecision` returns a `RecordedDecision` (not `null`) when the run
   expires mid-wait**, with `state:"timed-out"`, `approverId:"system:timeout"`,
   `decidedAt` = the record's `expiresAt`, and the shared `TIMEOUT_REASON` string.
   Note the deliberate asymmetry with `sweepExpired`, which stamps its own
   sweep time — the derived answer is anchored on the expiry instant so two
   readers who notice at different moments report one decision time.
5. **`submitDecision` now throws (rather than writing) on a non-literal
   `decision`, a blank `approverId`, or `approverId === "system:timeout"`.** These
   throw *before* the lock, so nothing is written and no lock file is created.
6. **`reportId` and `headSha` are trimmed** on both entry points, so
   `"rv-1\n"` now binds as `"rv-1"` and decides against `"rv-1"`.
7. **The truncation suffix lost its leading `…`** — any test asserting the old
   literal will fail. Cap arithmetic is unchanged (the suffix is one code unit
   shorter, so truncated text gains one character of payload).
8. **`supersededReportIds` no longer records an empty id, the still-live incoming
   id, or a duplicate.** The DoD property (every id ever bound is recoverable from
   `reportId` + `supersededReportIds`) is preserved; the array is just shorter in
   those three cases.
9. **The bundle guard now fires on the first request too**, message
   `cannot pause <run>: …` (rebind's wording is unchanged).
10. Internal only: the lock-body flag `fresh` was renamed `promote`, since it now
    marks two entries (fresh registration *and* resume). Not exported.

**Deliberately NOT done:** no cap on `supersededReportIds` (part of finding 11).
An append-only history with a hard cap is a brick, not a bound — the same trap
F4's finding 44 raises for `STRINGS_MAX_ELEMENTS` — and the DoD requires every
bound id stay recoverable, so shedding is a design question, not a review patch.
Dedupe + the two skips remove the realistic growth driver (repeated identical
rebinds). Also NOT done: real `teardown` wiring into the reverify runner — W3,
already deferred; finding 1 is the fail-closed stand-in.

## gitnexus impact

**The index is stale for this module and its results are not usable here.**
`impact({target:"withApprovalLock", direction:"upstream", repo:"QDS-Factory"})`
resolves the target to `Function:src/reverify/approval.ts:withApprovalLock` — its
*pre-DF3.4* location. The function lives at `src/fleet/approval-gate.ts:92` on
this branch. `submitDecision` and `awaitDecision` both return
`"Target not found"`, and `requestApproval` returns 4 ambiguous candidates all
pointing at `src/reverify/approval.ts`. Nothing in the graph knows
`src/fleet/approval-gate.ts` exists, so every number below is from grep instead.

Raw results, for the record:

- `withApprovalLock` upstream: `impactedCount: 1`, `risk: LOW`, one depth-1
  caller (`requestApproval`), one module (`Reverify`) — against the old file.
- `requestApproval` upstream: `status: ambiguous`, 4 candidates, `maxRisk: LOW`,
  `maxImpactedCount: 1`.
- `submitDecision`, `awaitDecision`: `Target 'X' not found`, `risk: UNKNOWN`.

Grep-derived caller set (authoritative), all verified before editing:

| Symbol | Callers | Risk |
|---|---|---|
| `withApprovalLock` | internal only (gate :316/:399/:430/:504); exported but no external caller | LOW |
| `requestApproval` | `src/reverify/approval.ts:66` → `src/reverify/runner.ts:413`; `tests/fleet/{approval-gate,gate-verbs}.test.ts`; `tests/fleet/e2e/tier1-approval-gate.live.test.ts:222` | MED — behavior changes 1, 2, 3, 6 reach the runner |
| `submitDecision` | `scripts/fleet.ts:2438` (approve/reject verbs) | MED — new pre-lock throws; `scripts/fleet.ts` is F5's file, see below |
| `sweepExpired` | `scripts/fleet.ts:2433` | LOW — untouched |
| `expiredState` | `src/fleet/status.ts` (F3's file) | LOW — untouched |
| `recordApprovalPort` | `src/reverify/runner.ts:406`, `src/reverify/index.ts:22` | LOW — signature unchanged, doc only |

**No HIGH or CRITICAL.** Two cross-owner notes for the lead:

- **F5 (`scripts/fleet.ts`)**: `submitDecision` now *throws* on a blank/reserved
  `approverId` and a non-literal decision. F5's finding 57 (`--approver ""` should
  be exit 2, not exit 5) is now backstopped at the gate — but an unhandled throw
  from `submitDecision` would surface as exit 1, not exit 2, so F5 should keep
  its own usage-level guard ahead of the call. Verified `tests/fleet/gate-verbs.test.ts`
  does not currently exercise a blank `--approver` against a real gate, so nothing
  of theirs breaks today.
- **T1 (live e2e)**: `tier1-approval-gate.live.test.ts:222` passes a real
  `teardown`, so behavior change 2 does not affect it. Its record also carries a
  `vmName` on an open record — which is exactly the case the new guard protects,
  and it passes the seam, so it stays green.

## Focal tests — verbatim

```
$ bun test tests/fleet/approval-gate.test.ts tests/reverify/
bun test v1.4.0 (34cbb9a40)

 125 pass
 0 fail
 339 expect() calls
Ran 125 tests across 6 files. [82.27s]
```

First run, no re-run needed. (121 before my 4 additions.)

## biome — verbatim

```
$ bunx biome check --write src/fleet/approval-gate.ts src/reverify/approval.ts tests/fleet/approval-gate.test.ts
Checked 3 files in 16ms. No fixes applied.
```

## tsc — verbatim

```
$ bunx tsc --noEmit
tests/phase-engine/steering.test.ts(871,7): error TS2322: Type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => number' is not assignable to type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => void | Promise<void>'.
  Type 'number' is not assignable to type 'void | Promise<void>'.
tests/phase-engine/steering.test.ts(887,7): error TS2322: [same]
tests/phase-engine/steering.test.ts(901,7): error TS2322: [same]
```

```
$ bunx tsc --noEmit 2>&1 | grep -oE "^[^(]+\.tsx?" | sort | uniq -c
   3 tests/phase-engine/steering.test.ts
```

**Zero errors in any file I own.** All 3 are in `tests/phase-engine/steering.test.ts`
— F4's surface, mid-edit (an `onInboxError` observer returning `number` where the
port declares `void | Promise<void>`, which is plausibly *their* finding 40 fix in
progress). An earlier `tsc` run in this session showed ~40 TS1005/TS1127 parse
errors in `src/phase-engine/steering.ts` that had disappeared by the next run —
that file was being written between my two invocations. IGNORED per instructions.
