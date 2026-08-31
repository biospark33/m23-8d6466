# Fixer F5 — runner-scripts (PR #150 round 7)

Files edited: `src/reverify/runner.ts`, `scripts/fleet.ts`, `scripts/pipeline-run.ts`, `scripts/lib/cost-ledger-opts.ts`
Tests added/updated: `tests/fleet/gate-verbs.test.ts`, `tests/reverify/runner.test.ts`, `tests/scripts/cost-ledger-opts.test.ts`, `tests/phase-engine/pipeline-run.test.ts`

Impact analysis run before each edit (`runGateVerbs`/`run`/`main`/`reverify`/`costLedgerOpts`, upstream).
Blast radius stayed in `scripts/`, `src/reverify`, `tests/fleet`, `tests/reverify`, `tests/scripts`, `tests/phase-engine`.
`costLedgerOpts` reported HIGH (6 direct callers across 4 CLI entry scripts); the fix is additive
inside its own failure arm, so no conservative fallback was needed. `detect_changes` at the end
reports "critical" only because it sees the whole round's combined uncommitted tree (45 symbols,
including F1–F4's files); the touched symbols in my four files are exactly my scope.

## Item 32 [MED] — runner approval pre-read outside the catch — FIXED

`src/reverify/runner.ts:444`. The `store.get(runId).extensions?.approval` bound-read sat beside the
`try` that wraps `port.requestApproval`, so a record deleted/corrupted between reverify's earlier
reads and the green verdict threw past the typed outcome — the AC4 violation the surrounding catch
exists to prevent. The read is now the first statement inside the try; an unreadable record degrades
to the flagged `approval-request-failed` path with the fresh reportId fallback.

Test: `tests/reverify/runner.test.ts` "a record that became UNREADABLE before the pre-read also lands
flagged, not thrown (F5.32)" — store wrapper that fails from the second read onward (the first read is
the earlier budget/identity read, whose failure is a different, already-covered `error` path).
Verified passing against the fix.

## Item 33 [MED] — `JSON.stringify(e)` destroys the fault — FIXED, with a correction to the finding

`scripts/pipeline-run.ts:1733`. The payload is now explicit fields: `{ runId, requestId, detail }`.

Correction: the reviewer's trigger ("`onInboxError` receives an `Error`") is a false positive —
steering's `onInboxError` signature (`src/phase-engine/steering.ts:356`) and its only call site
(steering.ts:514) always pass a plain `{runId, requestId, detail}` object with enumerable own
properties, so the old code never actually serialized `{}`. Verified empirically: a red/green
experiment reverting the payload shape left the new e2e test's assertions satisfied in BOTH shapes.
The explicit-fields form is kept anyway — it names the contract instead of relying on the observer's
argument shape, and would survive a future refactor of the observer's signature.

Test: `tests/phase-engine/pipeline-run.test.ts` "a broken steering inbox lands a steeringInboxError
trace row whose payload CARRIES THE FAULT (F5.33/F5.34)" — full runner e2e over the fake-resident
fixture with a directory planted at `QDS_STEERING_ROOT/inbox.ndjson` (EISDIR, the non-ENOENT broken-
channel arm); asserts the trace row's `detail` names the steering inbox fault and carries the join keys.

## Item 34 [MED] — unawaited `tracer.trace` rejection — FALSE POSITIVE (verified, comment retained)

`Tracer.trace` is a synchronous method (`src/phase-engine/trace/tracer.ts:525`, declared `: void`;
its JSONL leg is `fs.writeSync` and its SQLite leg is synchronous `bun:sqlite`, with failures
reported through the `onTraceError` callback rather than rejection). There is no Promise to escape
the sync try/catch. No code change; the existing `catch` fully contains the one failure shape that
exists. A draft fix that wrapped the call in an async IIFE was rejected as actively harmful — it
would convert a contained sync throw into an unhandled rejection past the catch.

## Item 35 [MED] — `forced` audit flag lies on `changed` — FIXED

`scripts/fleet.ts` unlock block. `forced: res.holder !== "dead"` derived the audit fact from the
SUCCESSOR's holder status: on the `changed` outcome (holder replaced between inspection and fenced
removal) a plain no-flag reclaim logged `forced: true`. `forced` is now derived once from
`bools.has("--force")` — this invocation's own flag — and used in BOTH the gate event and the stdout
completion line (the completion line had the same defect; the source-pin test caught it during the
round).

Tests: existing verbs.test.ts probe rows (`gate-u-dead` → `forced:false`, `gate-u-forced` →
`forced:true`) still pass unchanged. New gate-verbs.test.ts source pin (F5.35) for the
probe-unreachable `changed` interleaving: the event derives from the invocation flag and the old
holder-derived expression is absent from the file.

## Item 36 [MED] — "box torn down" asserted for unenumerated states — FIXED

`scripts/fleet.ts` attach `run-not-attachable` remediation. The catch-all is now four-way:
`no-box` / `pausing`+`awaiting-approval` / an EXPLICIT terminal set (`approved`, `rejected`,
`timed-out`, `closed` — the states where `requestApproval`'s pre-promotion teardown genuinely
establishes "the run is over") / a final inspect-first arm: `this run reports the state "…", which
takes no steering — run \`fleet status <id>\` and inspect the box before acting`. The unknown-state
text asserts nothing about the box and echoes the state through `sanitizeLabel(…, 64)`.

Test: gate-verbs.test.ts "an UNRECOGNISED state → the inspect-first remediation, no torn-down claim
(F5.36)" — drives a `from-the-future` state; asserts the remediation names `fleet status`+inspect and
contains neither "this run is over" nor "torn down".

## Item 37 [MED] — "IS queued" asserted for unknown reasons (+ DN1 DF1.10 text) — FIXED

`scripts/fleet.ts` attach `attach-not-acked` remediation chain. Split into five arms: `send-failed`
(unchanged), `acks-unreadable` (unchanged), `box-unreachable` (unchanged), explicit `no-ack`, and a
genuine catch-all. Per DN1, the `no-ack` text now states the DF1.10 reality: "the message IS queued in
the box, but no in-box executor exists yet (DF1.10), so nothing drains it and no ack can arrive — the
guidance lands when DF1.10 ships; a re-send delivers it twice (the messageId is the dedupe key). …"
The fold-budget clause is retained. The catch-all asserts nothing: `unrecognised ack outcome (…) —
run \`fleet status <id>\`, inspect the box's inbox and acks files, and treat the message as possibly
delivered before re-sending`.

Tests: the existing no-ack test was extended to pin the DF1.10 clause. A new F5.37 test pins the
catch-all at source — it is unreachable from this build (the CLI reads `reason` from
`attachToRun`'s four-member union and has no injection seam for the library call), so the test reads
the remediation chain out of `scripts/fleet.ts` and asserts the final arm contains no "IS queued"
and points at `fleet status`. Note: `tests/fleet/e2e/tier1-attach-transport.live.test.ts` and
`tier5-gate-steering.live.test.ts` call the old text "the SHIPPED CONTRACT" in comments but assert
only `reason: "no-ack"` / exit 6 — no live-suite edit needed (live suites were not run here).

## Item 38 [LOW] — `boundState` "absent" claimed on failed read — FIXED

`scripts/fleet.ts` approve/reject pre-auth read. The default is now `"unknown"`; `"absent"` is only
assigned after a read that SUCCEEDED and found no extension.

Test: gate-verbs.test.ts "a FAILED record read logs state \"unknown\", never the observation
\"absent\" (F5.38)" — all-throwing store, auth refused, gate event asserts `state: "unknown"`.

## Item 39 [LOW] — one throwing sink permanently silences gate events — FIXED (and one layer out)

`scripts/fleet.ts` `gateEvent` and `logVerb` (the fix's blast radius reached one producer further:
`finish` → `logVerb` also calls `log()` unguarded, and a raising sink there crashed the invocation's
own completion line outside every verb try). Both now contain the sink raise and emit ONE stderr line
per process — "fleet: warning: the structured log sink is raising — gate events are being dropped" —
via a shared module-level `warnSinkRaising()`. Events stay dropped (a broken sink is broken); exit
codes stay correct; the note rides `process.stderr.write` so tests can capture it (same seam as
tests/providers/cost-ledger.test.ts:1076).

Test: gate-verbs.test.ts "a RAISING sink drops the event but warns on stderr ONCE per process
(F5.39)" — throwing sink across two invocations; asserts exit codes unchanged and exactly one warning.

## Item 40 [LOW] — `...fields` spread can clobber computed fields — FIXED

`scripts/fleet.ts` `gateEvent`. `fields` is now spread FIRST and the computed keys (`requestId`,
`operation`, `agentId`, `timestamp`, `duration`, `durationMs`, `status`, `runId`, `event`,
`dispatchRequestId`) come after it, so no caller-supplied key can override them. All current callers
pass none of those keys (verified by audit) — every gate event's observable shape is unchanged. A
re-assert-after-spread variant was tried first and rejected: TS1117 forbids duplicate literal keys.

## Item 41 [LOW] — decided line/gateEvent omit `reason` (INV-APPROVE-4) — FIXED

`scripts/fleet.ts` approve/reject. The fresh `decided` completion line now carries `reason` (capped
with `sanitizeLabel(flags.get("--reason") ?? "", MAX_REASON_CHARS)` — the same imported bound the
persisted write uses; re-capped here because approval-gate's `capText` is not exported and the line
must never echo unbounded argv), and the gate event carries the same `line.reason`. `already-decided`
already had it; both streams now join on the reason as well as the run.

Tests: gate-verbs.test.ts "a FRESH decision carries its reason on the completion line AND the gate
event (F5.41, INV-APPROVE-4)" and "an OVERLONG --reason arrives on the log line CAPPED, not raw".

## Item 42 [LOW] — silent migration failure + shadowed `tmp` — FIXED

`scripts/lib/cost-ledger-opts.ts` `withMigrationLock`. The inner shadowing `const tmp` is removed —
one pid-stamped path serves the try and the catch's cleanup. The catch now names its cause on stderr
via `noteStderr`: "warning: cost ledger migration failed (<message>); using legacy <path>" — the
fallback is correct but permanent, so the reason has to be findable. `noteStderr` itself was switched
from raw `writeSync(2)` to `process.stderr.write` (same fd 2 in production; the process stream is the
seam tests capture) and the now-unused `writeSync` import dropped.

Test: tests/scripts/cost-ledger-opts.test.ts "the failure names its cause on stderr — the legacy
fallback is permanent, not silent (F5.42)" — non-database legacy file; asserts the warning appears
once with "legacy" naming the read path. Existing race/lock/cleanup tests all still pass.

## Verification

- `bun test tests/reverify/ tests/fleet/cli.test.ts tests/fleet/gate-verbs.test.ts` → 344 pass, 0 fail
- Wider sweep (fleet, reverify, scripts, pipeline-run, steering suites) → 1477 pass, 0 fail, 2 skip
- `bunx biome check --write` on all eight touched files → clean
- `bunx tsc --noEmit` → clean

## Intentional behavior changes (operator-visible)

1. `fleet attach` `run-not-attachable` with an unknown approval state now says "run `fleet status`
   and inspect the box" instead of asserting the box was torn down (was false for live runs).
2. `fleet attach` `no-ack` remediation now states the DF1.10 no-in-box-executor reality (DN1) and
   drops "check the resident agent is running" as the primary action.
3. `fleet unlock` gate event + completion line: `forced` reflects `--force`, not the (possibly
   successor's) holder status.
4. `fleet approve`/`reject` refusal events can log `state: "unknown"` after a failed record read;
   fresh decision lines/events carry `reason`.
5. A raising log sink produces one stderr warning instead of silence (events still dropped).
6. A failed ledger migration logs its cause on stderr (fallback behavior unchanged).
