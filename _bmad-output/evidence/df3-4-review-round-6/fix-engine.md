# F4 — `src/phase-engine/steering.ts`, `src/providers/run-record.ts`

Owned files touched (and ONLY these):
- `/Users/steve/QDS-Factory/src/phase-engine/steering.ts`
- `/Users/steve/QDS-Factory/src/providers/run-record.ts`
- `/Users/steve/QDS-Factory/tests/phase-engine/steering.test.ts`
- `/Users/steve/QDS-Factory/tests/providers/run-record.test.ts`

## Verdict table

| # | Sev | Verdict | Note |
|---|-----|---------|------|
| 39 | HIGH | **fixed** | Two sets: `delivered` (fold once) and `acked` (retry until it sticks). Fold and ack are now separate facts; the ack is retried on every later drain until it lands. |
| 40 | HIGH | **fixed** | `onInboxError` is now `=> void \| Promise<void>` and is `await`ed inside its try/catch. Confirmed real: an `async` observer type-checked against `=> void` and its rejection escaped the catch. |
| 41 | HIGH | **fixed** | `drainInbox` moved ABOVE the `status !== "active"` early return. Verified the latch: `"degraded"` is written at 3 sites, `"active"` is written exactly once (initializer) and never reassigned. Resident CALL still stops at the gate (INV-RES-5 untouched). |
| 42 | MED | **fixed** | Ack failure now routes through the same `reportInboxFault` as the drain failure, with a DISTINCT detail (`steering inbox ack failed for <id>: …` vs `steering inbox unreadable: …`) so the two faults stay tellable apart. |
| 43 | MED | **fixed** | Declarative `retired` map on the namespace spec (`approval.retired = { supersededReportId: "supersededReportIds" }`) + a write-only migration in `validateExtensions`: fold the scalar into the array at the HEAD if absent, then drop it. Fail-safe — never loses an id, idempotent, never duplicates. |
| 44 | MED | **fixed in the store** | The COUNT bound now SHEDS (drop-oldest, `shedStrings`) instead of throwing; the per-element LENGTH bound still throws. No change needed in the gate — see "Belongs to another owner" below for the one consequence its owner should know about. |
| 45 | MED | **fixed** | New `SteeringController.lastInboxErrorReason` slot. Inbox faults no longer write `lastDegradationReason`, so the self-contradictory (`status: "active"`, reason: "steering inbox unreadable") pair is gone. |
| 46 | MED | **fixed** | `ATTACH_FOLD_CHAR_BUDGET = PROMPT_CHAR_CEILING / 2` (8 000), counted across every solicitation for the run. Over budget ⇒ not folded, **not acked** (so `fleet attach`'s "still queued" stays true), one fault reported, `break` (queue is oldest-first). |
| 47 | MED | **fixed** | `INBOX_CALL_TIMEOUT_MS = 5_000` on both `drain` and `ack`, via a local `withDeadline`. Deliberately NOT an import of `src/providers/timeout.ts` — the engine imports no provider/fleet code (file header, R3 §9.2) and a new dependency edge costs more than 8 lines. Same late-rejection discipline (`void p.catch(() => {})` before the race). |
| 48 | LOW | **fixed** | `strings` is now an explicit branch and the tail is `const unhandled: never = kind`. Kind #5 is a compile error, not a silent fallthrough. |
| 49 | LOW | **fixed** | `messageId` capped at `DIRECTIVE_ID_CHAR_CEILING` in the prompt line. The run-lifetime retention in `delivered` is unchanged (see 53). |
| 50 | LOW | **fixed** | Cap moved after sanitization on BOTH halves: `sanitizeForMessage(message).slice(0, CEILING)`. Confirmed the expansion (`sanitizeForMessage` = `JSON.stringify` + `\uXXXX` pass; `\x7f` → 6 chars). |
| 51 | LOW | **fixed (docstring)** — not a live bug | Verified: the read-mode call site's result is DISCARDED. `assertWellFormed` calls `validateExtensions(value, undefined, "read")` for validation only and `readRecord` returns the parsed object itself, so the aliasing entry is unreachable and collected. The precondition claim was wrong; the code was not. Docstring now states the read-path exception and what a future caller of read mode's result must do. |
| 52 | LOW | **fixed** | `approval.schemaVersion` 1 → 2. **Non-additive — see the loud warning below.** |
| 53 | LOW | **fixed (dedupe half)** | `onInboxError` dedupes on the exact detail: a channel that stays broken fires once, a DIFFERENT fault still fires. No backoff added (dedupe makes it moot — a stable fault produces one call for the run). `delivered`/`acked` still grow for the run's lifetime: deliberate, they are the AC6 fold-once and the ack-retry ledgers, and a run's message count is now bounded by `ATTACH_FOLD_CHAR_BUDGET` anyway. |
| 54 | LOW | **fixed** | New `ATTACH_MESSAGE_CHAR_CEILING` (inbound) beside `DIRECTIVE_TEXT_CHAR_CEILING` (outbound). Equal today by coincidence, documented as not-by-contract. |

**0 false positives.** Every finding reproduced against the real code.

## BEHAVIOR CHANGES (re-pin these)

Steering:
1. **Inbox faults no longer touch `lastDegradationReason`** — they land on the new `lastInboxErrorReason`. New public member on `SteeringController`.
2. **An ack failure now fires `onInboxError`** (it previously fired for drain failures only). Detail text: `steering inbox ack failed for <id>: <cause>`.
3. **`onInboxError` fires at most once per distinct detail** for the run.
4. **The inbox drains while the resident is degraded/disabled/stopped.** Follows the finding's explicit instruction. Nuance worth a second opinion: a message folded after the resident is gone is acked (it did reach `promptContext`) but no prompt is ever rendered from it. `attach-acked` therefore means "folded", not "a model saw it" — which is what AC6 defines the ack as, but the operator-facing wording in `fleet attach` is not mine to change. Flagging for the attach owner.
5. **`onInboxError`'s type widened** to `=> void | Promise<void>`. Source-compatible for `scripts/pipeline-run.ts:1722` (sync). It DOES break `(e) => arr.push(e)` expression-body lambdas under `tsc` (a `void`-returning signature accepts any return type; a union does not) — three such lambdas in my own test file were converted to statement bodies.
6. **New exported constants**: `ATTACH_MESSAGE_CHAR_CEILING`, `ATTACH_FOLD_CHAR_BUDGET`, `INBOX_CALL_TIMEOUT_MS`.
7. **Bounded attach delivery**: past 8 000 folded chars a message is neither folded nor acked, for the run's lifetime.

run-record:
8. **`approval.schemaVersion` is 2.** Every `store.set` touching `extensions.approval` now stamps 2 (records on disk at 1 are read fine; the read path already tolerates skew in both directions).
9. **An over-count `strings` write no longer throws — it sheds the oldest** and writes, with a `noteOnStderr` line. The message `… has N elements, over the 256 bound` is now unreachable from the extension write path.
10. **A legacy `supersededReportId` scalar is folded and removed** on the next write to `extensions.approval`. Writing the legacy key explicitly is still `unknown key`.

## LOUD: run-record.ts is NOT additive-only

Three of my changes are visible to suites I did not run (`tests/fleet/*`, `tests/providers/teardown.test.ts`, `tests/reverify/*`, `tests/providers/budget-gate.test.ts`):

- **`approval.schemaVersion: 2`** — anything asserting `schemaVersion: 1` on an approval entry READ BACK FROM THE STORE will fail. I grepped: every current hit is either a hand-built `ExtensionEntry` literal passed straight to `expiredState` (`tests/fleet/approval-gate.test.ts:459-480`), a store-double fixture that never routes through `validateExtensions` (`tests/fleet/cli.test.ts:3653`), or a different namespace (`pr`/`fanout`/`budget`, untouched). Worth one grep at the final gate anyway, since three fixers are editing those files concurrently.
- **the shed replacing the throw** — a test asserting the count-bound rejection message would now fail. The only one was in my own file and is re-pinned.
- **the retired-field migration** — it mutates the persisted shape of `extensions.approval` on records that carry the legacy scalar. Nothing else in-tree writes that scalar.

`assertKind` itself is behaviour-identical for `string`/`int`/`ports`; the `strings` arm is reached only by `extensions.approval.supersededReportIds`.

## Belongs to a file I do NOT own

- **`src/fleet/approval-gate.ts` (fix-gate)** — no change required for #44; the store now absorbs it. But state the consequence in the gate's docs: past 256 rebinds on one run, `supersededReportIds` sheds its OLDEST entries, so the DoD "no decision may name a `reportId` absent from both `reportId` and `supersededReportIds`" degrades to "absent from the most recent 256". If that DoD must be absolute, the gate needs its own policy (refuse the 257th rebind with a NAMED gate refusal) rather than relying on an unnamed store exception — which is what it was relying on, and which bricked every later write.
- **`src/fleet/attach.ts` (fix-attach)** — two contract facts changed under it: (a) a failed ack is now RETRIED, so an `attach-not-acked` that used to be permanent now self-heals on the next solicitation; (b) a message refused by the fold budget is deliberately left un-acked, so `attach-not-acked` gains a second, permanent cause that the remediation text ("re-send") makes worse. Worth a distinct remediation line.
- **`scripts/pipeline-run.ts`** — `onInboxError` now also carries ack failures and fold-budget exhaustion, not just unreadable-channel faults. Its `steeringInboxError` trace name still fits; no edit needed.

## gitnexus impact

`impact({target: "assertKind", direction: "upstream", repo: "QDS-Factory"})` — **risk: CRITICAL**, 8 impacted (3 direct), 6 execution flows: `teardownRun`, `scripts/fleet.ts:run`, `requestApproval`, `reapRuns`, `scripts/run-record.ts:run`, `provisionAdmittedRun`; module `Providers`.
Proceeded deliberately, and the CRITICAL rating is about the symbol's centrality, not this diff: the `string`/`int`/`ports` arms are byte-identical, the added `never` guard is unreachable for the four current kinds, and the only relaxation (the count throw) is on a kind that exists for exactly one field, now shed upstream of it.

`impact({target: "validateExtensions", ...})` — **risk: LOW**, 7 impacted (2 direct: `setLocked`, `assertWellFormed`). Both call sites re-read and re-verified by hand; the migration is guarded `mode === "write"` so the read path is untouched.

`detached`/`shedStrings` are module-private (no external callers).

## Verbatim output

### `bun test tests/phase-engine/steering.test.ts tests/providers/run-record.test.ts`

```
bun test v1.4.0 (34cbb9a40)
run-record: extensions.approval.supersededReportIds reached the 256-element bound; dropping the 1 oldest

 166 pass
 0 fail
 670 expect() calls
Ran 166 tests across 2 files. [40.72s]
```

(The `run-record:` line is `shedStrings`'s own stderr diagnostic firing in the shed test — expected, not a warning.)

### `bunx biome check --write <4 files>`

```
Checked 4 files in 59ms. No fixes applied.
```

### `bunx tsc --noEmit` (whole project)

```
(no output — clean)
```

Clean across the WHOLE project, including the five other fixers' in-flight edits at the time of the run. No errors to disclaim.

## Tests added (behaviour these fixes introduce; the test wave may supersede)

`tests/phase-engine/steering.test.ts`
- a failed ack is RETRIED on the next solicitation, and the message folds only once (#39)
- the inbox drains even after the resident has degraded (#41)
- the run-wide fold budget bounds attach text, and an unfolded message is NOT acked (#46)
- the message cap is applied AFTER sanitizing, not before (#50)
- re-pinned: drain fault → `lastInboxErrorReason` with `lastDegradationReason` null (#45); ack failure DOES fire `onInboxError` with an ack-specific detail (#42)

`tests/providers/run-record.test.ts`
- a pre-DF3.4 record's singular `supersededReportId` is FOLDED into the array on the next write (#43)
- re-pinned: the COUNT sheds oldest-first, the element LENGTH is still a rejection (#44); `schemaVersion: 2` (#52)
