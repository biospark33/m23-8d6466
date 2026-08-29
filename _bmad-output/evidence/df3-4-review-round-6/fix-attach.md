# F3 — fix report: `src/fleet/attach.ts`, `src/fleet/status.ts`

Files touched: `src/fleet/attach.ts`, `src/fleet/status.ts`. **`tests/fleet/attach.test.ts` needed no edit** — all 10 tests pass unchanged against the new behavior.

## Verdict table

| # | Verdict | Note |
|---|---------|------|
| 25 | fixed | `attachToRun` now refuses when the approval state is set to ANY value (`state !== undefined`, so an unknown future state fails closed too) and, separately, when `rec.closedAt !== undefined` (state `"closed"`). Both before the vmName guard, so nothing is queued. |
| 26 | fixed | The append no longer throws. Timeout *and* non-zero exit both return `{outcome:"attach-not-acked", reason:"send-failed", detail}` → the CLI's existing arm gives **exit 6**, not 1. See "CHANGE NEEDED IN scripts/fleet.ts" — the exit code is already correct without it; only the remediation *text* needs the branch. |
| 27 | fixed | `APPEND_SCRIPT` ends with a newline guard: `{ [ ! -s "$f" ] || [ "$(tail -c1 "$f")" = "" ] || echo >> "$f"; }`. Still one `sh -c`; `umask 077` / `mkdir -p` / `chmod 600` semantics unchanged. Verified standalone against a real `sh` with a hand-torn file: the fragment stays one bad line and the next message lands on its own line. |
| 28 | fixed | The box-side path is now resolved **by the box**: `root="${QDS_STEERING_ROOT:-/run/steering}"` is a `sh` parameter expansion inside the script, not a host interpolation. On a real box the var is unset → `/run/steering`, identical to the engine leg (which reads the box's env). Test seam intact: FakeDriver's exec passes `env: process.env` (`fake-driver.ts:358`), so the suite's override still reaches the host leg. `steeringRoot()/inboxPath()/acksPath()` remain for the LOCAL callers (engine leg + tests) and their doc now says so. `shellQuote` deleted — nothing host-supplied is interpolated any more. |
| 29 | fixed | `readAck` returns a fourth verdict `"unreachable"` for a thrown/timed-out ack read (a non-zero `cat` stays `"absent"` — "not there yet" is still the right reading of it). Three consecutive unreachable ticks abandon the poll with `reason:"box-unreachable"` instead of 60 absent ticks and a false remediation. |
| 30 | fixed differently — see below | Guard NOT changed to `boxes !== null && box === undefined`: that would have made a list outage fall through to the `closed` arm and report a run sitting on an approver's desk as finished — the exact AC7 ordering bug the live tier-1 demo caught. The outage is carried as EVIDENCE instead: the paused row now carries `boxAlive: false` when the list answered and OMITS it when `boxes === null`, which is the file's existing "no evidence either way" rule. `statusAll` still emits its `listUnavailable` fleet row. |
| 31 | fixed | The approval arm merges instead of short-circuiting: `{...base, ...approval, closedAt?, boxAlive?}`. **Breaks one assertion in a file I do not own — see "TEST RE-PIN OWED".** |
| 32 | half false positive, half mitigated | FALSE: "ensure an abandoned exec's later rejection cannot surface as an unhandled rejection" is already true — `withTimeout` does `void p.catch(() => {})` *before* the race (`src/providers/timeout.ts:47`) and documents why. REAL: nothing cancels the abandoned exec. Mitigated, not fixed: the new `box-unreachable` streak caps outstanding hung sessions at 3 instead of the ~60 a full 30 s poll would start. A true fix needs an abort path on `ProviderDriver.exec`, which the port does not have (not my surface). |
| 33 | fixed | Per-tick timeout is `max(ATTACH_MIN_TICK_MS, min(perCallTimeoutMs, ceilingMs - elapsed))`, so the ceiling is a real bound. |
| 34 | fixed | `acks-unreadable` is now its own `reason`, distinct from `no-ack`. |
| 35 | fixed | `pollIntervalMs`/`perCallTimeoutMs` floored at `ATTACH_MIN_TICK_MS = 10` and NaN-guarded. `ceilingMs` deliberately gets NO floor — the poll became a `do/while`, so `ceilingMs: 0` now means "one look, do not wait" rather than "no poll at all", and the suite's small ceilings still run fast. |
| 36 | fixed | `localSteeringInbox().drain()` reads through `readInboxTail`: `openSync`/`fstatSync`, and above `INBOX_READ_CAP_BYTES` (1 MiB) it reads only the last 1 MiB and drops the leading partial line. Still never truncates the file (that remains unsafe against a concurrent `cat >>`). Tail not head, because steering guidance is about what to do next. |
| 37 | fixed | `rowForRecord`'s doc comment moved back above `rowForRecord`; `approvalRowFields` keeps its own. |
| 38 | **FALSE POSITIVE** | `sanitizeLabel` appends `…` on truncation (`brief-schema.ts:187`: `capped.length > max ? \`${capped.slice(0, max - 1)}…\` : capped`). A truncated `reportId` is visibly partial, which is the "visibly partial, never silently short" rule the file already states. No fix. |

**Score: 11 fixed, 1 false positive, 1 half-and-half (32).**

## BEHAVIOR CHANGES (for the test wave to re-pin)

1. **New `run-not-attachable` states.** `attachToRun` can now return `state` ∈ `{"pausing","awaiting-approval","approved","rejected","timed-out",<any unknown approval state>,"closed","no-box"}`. Previously only the first two plus `"no-box"`.
2. **`AttachResult` shape.** `attach-not-acked` now carries a required `reason: "no-ack" | "send-failed" | "acks-unreadable" | "box-unreachable"` and an optional `detail` (bounded 200 chars, `send-failed` only). New exported type `AttachNotAckedReason`. Both ride out in the CLI's stdout JSON (`{runId, ...res}`).
3. **The append never throws.** A failed/timed-out/non-zero append is `attach-not-acked` + `reason:"send-failed"` → **exit 6** through the CLI's existing arm. Previously a bare `Error` → `report()` → exit 1 ("retry me") → new `messageId` → double delivery.
4. **New exported constant** `ATTACH_MIN_TICK_MS = 10`.
5. **`StatusRow`:** `boxAlive` is now set on the two approval rows as well as `closed` (same tri-state rule: absent ⇔ `boxes === null`), and `closedAt` is now carried on approval rows. `StatusRow`'s field docs updated. No `state` values added or removed.
6. **In-box paths** are resolved by the box's own environment. A host `QDS_STEERING_ROOT` no longer steers the box leg — only local callers (engine leg, suite).

## TEST RE-PIN OWED (file I do not own)

`tests/fleet/cli.test.ts:3721` now fails — and it is the ONLY failure caused by these changes:

```
expect(row.closedAt).toBeUndefined(); // the paused row is not a closed row
Received: "2026-01-01T00:05:00.000Z"
```

That line pins exactly what finding 31 calls the defect. Suggested replacement:

```ts
expect(row.closedAt).toBe("2026-01-01T00:05:00.000Z"); // the pause overrides the STATE, not the facts
expect(row.boxAlive).toBeFalse();                      // ...and the row can finally say nothing is billing
```

All 11 other tests in that describe block pass (verified: `bun test tests/fleet/cli.test.ts -t "AC7"` → 11 pass, 1 fail).

## CHANGE NEEDED IN `scripts/fleet.ts` (owned by F5 — I did NOT make it)

Both are remediation TEXT only. Exit codes are already correct without either change (5 for `run-not-attachable`, 6 for every `attach-not-acked`), so nothing is broken if they are deferred — the operator just reads a sentence that is wrong for the new cases.

1. **`run-not-attachable` remediation (~fleet.ts:2570-2577).** The `else` arm says "the run is paused at the approval gate, so its box is gone — decide it with `fleet approve`/`fleet reject`". That is now reached by `closed`, `approved`, `rejected` and `timed-out` too, where it is false. Suggested three-way branch:
   - `res.state === "no-box"` → unchanged.
   - `res.state === "pausing" || res.state === "awaiting-approval"` → the current gate text.
   - otherwise → "this run is over (`<state>`) — its box was torn down and steering reaches a LIVE resident only; dispatch a new run".
2. **`attach-not-acked` remediation (~fleet.ts:2583-2598).** Branch on the new `res.reason` instead of always printing "the message IS queued in the box — check the resident agent is running before sending it again":
   - `no-ack` → unchanged (it IS queued).
   - `send-failed` → "the send FAILED and may or may not have landed (`res.detail`) — check the box before re-sending; a re-send delivers it twice if it did land".
   - `acks-unreadable` → "the acks file in the box is corrupt, not late — repair/remove `/run/steering/acks.ndjson`; the message itself is queued".
   - `box-unreachable` → "the box did not answer — verify it still exists (`fleet status <run>`) before re-sending".
   Also worth adding `reason` to the `gateEvent("attach", …)` fields, which currently log only `outcome`/`state`.

Not requested, noted only: `FleetError.exitCode` is typed `1|2|3|4|5` in `src/fleet/dispatch.ts:207` while `report()` accepts and documents 1–6. That mismatch is why the append failure is expressed as a RESULT rather than a typed throw. Nobody owns `dispatch.ts` in this wave; a one-token widening to `1|2|3|4|5|6` would make exit-6 refusals throwable from the library layer.

## gitnexus impact

- `impact({target: "attachToRun", direction: "upstream"})` → **`Target 'attachToRun' not found`**. The index predates this PR's new `src/fleet/attach.ts`; callers verified by grep instead — exactly one production caller (`scripts/fleet.ts:2559`) plus `tests/fleet/attach.test.ts` and `tests/fleet/gate-verbs.test.ts`.
- `impact({target: "rowForRecord", direction: "upstream", includeTests: true})` → **risk LOW**, impacted 9, direct 2 (`statusAll`, `statusRun`), processes `run` (scripts/fleet.ts) and `statusAll`, modules Fleet (direct) / Scripts (indirect). No HIGH/CRITICAL anywhere in this cluster.
- `StatusRow.closedAt` consumers checked by grep: **none** outside `status.ts` — every `closedAt` read in `src/`/`scripts/` is against the RECORD (`reaper.ts:624,704`, `cost-ledger.ts:1749`), not against a status row. So change (5) above is an output-shape change only.

## Verbatim verification output

```
### bun test tests/fleet/attach.test.ts
bun test v1.4.0 (34cbb9a40)

 10 pass
 0 fail
 49 expect() calls
Ran 10 tests across 1 file. [945.00ms]

### bun test tests/fleet/gate-verbs.test.ts (attach refusal coverage, not owned)
bun test v1.4.0 (34cbb9a40)

 31 pass
 0 fail
 68 expect() calls
Ran 31 tests across 1 file. [490.00ms]

### bunx biome check --write src/fleet/attach.ts src/fleet/status.ts tests/fleet/attach.test.ts
Checked 3 files in 9ms. No fixes applied.

### bunx tsc --noEmit (whole project)
tests/phase-engine/steering.test.ts(871,7): error TS2322: Type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => number' is not assignable to type '(e: { runId: string; requestId?: string | undefined; detail: string; }) => void | Promise<void>'.
  Type 'number' is not assignable to type 'void | Promise<void>'.
tests/phase-engine/steering.test.ts(887,7): error TS2322: (same)
tests/phase-engine/steering.test.ts(901,7): error TS2322: (same)
(exit 2)
```

**tsc: zero errors in any file I own.** The three remaining errors are in `tests/phase-engine/steering.test.ts` (F4's surface — an `onInboxError` observer returning `number` against the newly `void | Promise<void>`-typed hook). Ignored as instructed.

Earlier runs of both `bun test` and `tsc` failed with a parse error at `src/phase-engine/steering.ts:317`/`326` while the F4 fixer was mid-edit; re-ran after that file compiled and both are clean.
