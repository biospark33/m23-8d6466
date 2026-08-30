# PR #150 round-7 — fix cluster D (steering) report

Files owned: `src/phase-engine/steering.ts`, `scripts/pipeline-run.ts`, `tests/phase-engine/steering.test.ts`.
Findings: 7, 9, 10, 23.

## Verdict table

| # | Sev | Verdict | What changed |
|---|-----|---------|--------------|
| 7 | MEDIUM | **false positive** — no fix | `onInboxError` is invoked at exactly one site (steering.ts:465-467) with a plain `{ runId, requestId, detail }` object literal — never an `Error` instance — so `JSON.stringify(e)` at `scripts/pipeline-run.ts:1728` serializes fully (`detail` included). The `Error → "{}"` hazard does not exist on this path; the type at steering.ts:333 also forbids it. Error truthfulness was already handled upstream: `causeOf` (steering.ts:428) extracts `e.message` into `detail`, matching how sibling error-carrying lines in pipeline-run.ts serialize errors (e.g. `resident_disabled` uses `detail: err.message`, :1703); all other trace payloads stringify plain object literals exactly like this one. Secret check: details are harness-authored strings plus `e.message` from local fs errors (EACCES/ENOSPC/EIO + paths from `localSteeringInbox`) — no token/secret material can ride in. `scripts/pipeline-run.ts` is unmodified. |
| 9 | MEDIUM | **fixed** | `reportInboxFault` now wraps the observer push in the same `withDeadline(..., INBOX_CALL_TIMEOUT_MS)` pattern as the drain/ack calls (`Promise.resolve(...)` normalizes the `void \| Promise<void>` union; sync throws still land in the existing catch). A hung async observer is abandoned after 5s instead of wedging the serialized solicit chain. On timeout the fault itself remains recorded on `lastInboxErrorReason` (written before the push) — only the push is lost — and the dedupe latch stays set, because the next identical fault would just hang the same broken sink again. |
| 10 | MEDIUM | **fixed** | `drainInbox` tracks a per-pass `faulted` flag (set in all three fault paths: fold-budget exhaustion, ack failure, fold throw; the drain-failure early return never reaches the tail). A fault-free pass clears `lastPushedFault`, so a fault recurring after a healthy interval is a new incident and re-fires — while a persistently broken channel still fires exactly once (existing "STABLE fault fires exactly once" and "DIFFERENT fault still fires" tests unchanged and green). `lastInboxErrorReason` is deliberately NOT cleared: the existing test "an EMPTY drain leaves a PRIOR inbox fault standing" pins that. |
| 23 | LOW | **fixed** | `delivered` is now `Map<string, SteeringPoint>` recording the fold-time point; the ack call uses `delivered.get(messageId) ?? point` (the fallback is unreachable — acks only run for folded ids). A retried ack now records the solicitation whose prompt context the message actually reached, per the file's own ack semantics ("reached a solicitation's prompt context", written at fold time). |

## gitnexus impact (pre-edit)

`node .gitnexus/run.cjs impact createSteering --direction upstream --repo QDS-Factory`:
- risk **LOW**, 3 impacted nodes, 1 direct caller: `main` in `scripts/pipeline-run.ts`; 1 process affected (`Main → TracerError`); depth-3 import by `scripts/pipeline-run-remote.ts`.
- No exported signature changed (all edits are inside `createSteering`'s closure); `scripts/pipeline-run.ts` needed no edit.

## Intentional behavior changes (flags)

1. **Observer push is now deadline-bound (5s).** A hung `onInboxError` no longer blocks `solicit`; its push is abandoned. Previously it blocked forever.
2. **Dedupe latch resets on recovery.** After any fault-free drain pass, a byte-identical fault re-fires `onInboxError`. Previously it could never fire again for the run's lifetime. Stable-fault dedupe (flood guard) is unchanged.
3. **Retried acks record the fold-time `SteeringPoint`.** Ack rows written on retry now carry the point at which the message was folded, not the retry solicitation's point. First-try acks are unchanged.

## Regression tests added (tests/phase-engine/steering.test.ts)

New describe "steering — observer deadline, dedupe recovery, and fold-time ack point":
- **#9:** hung observer → both solicits resolve, elapsed ∈ [5s−ε, 15s), `lastInboxErrorReason` still holds the fault, resident stays `active`.
- **#10:** fault → deduped across solicits → healthy pass (no push, latch reset) → byte-identical fault re-fires; stable-fault single-fire asserted on the same controller.
- **#23:** ack fails at `run_start`, succeeds on retry under `post_gate_failure`; recorded ack point is `run_start`.

## Verification

- `bun test tests/phase-engine/steering.test.ts` → exit 0, **78 pass / 0 fail** (failure-extraction pipeline clean: no `(fail)`/`^error` lines).
- `tests/scripts/` contains no pipeline-run suite (Glob: sandbox-teardown-cli, qds-cost, install-gitnexus-embeddings, cli-args, roster-check, license-sweep, mcp-stdio-client, coms-smoke-helpers) and `scripts/pipeline-run.ts` is unmodified — the conditional suite run did not apply.
- `bunx tsc --noEmit` → **0 errors**.
- `bunx biome check src/phase-engine/steering.ts scripts/pipeline-run.ts tests/phase-engine/steering.test.ts` → **clean**.

Nothing committed. Nothing deferred.
