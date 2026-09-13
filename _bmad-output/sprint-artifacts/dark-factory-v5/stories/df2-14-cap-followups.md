# DF2.14: Key-Cap Bound at Every Entry + Structured Mint-Failure Remediation (PR #254 Review Round 1 Deferred Findings D1 + D2)

**Story Points:** 1
**Sprint:** v5 (unslotted follow-up; both findings surfaced and triaged by PR #254 review round 1, commit f96e7b53)
**Status:** done

## Spec Reference

- INV-CAP-1 (DF2.13): `mintRunKey` refuses any `capMicroUsd > defaultKeyCapMicroUsd` pre-mint
  (`src/providers/credentials.ts`) — the caller-agnostic enforced bound. UNCHANGED here.
- Effective mint ceiling = `min(keyCap, remaining)` (`src/providers/cost-ledger.ts`); `keyCap`
  = `deps.capMicroUsd ?? defaultKeyCapMicroUsd`. Only the keyCap operand may be bounded —
  issue caps (`defaultCapMicroUsd` / `perIssueOverrides` via `capForIssue`) are legitimately
  absorbed by the `min` and are deliberately NOT bounded.
- PR #254's DF2.13 comment block documented the stranded-box cost as "accepted" and filed
  "bounding the caps at load" as this follow-up. This story lands it and retires the accepted cost.

## Findings

**D1 — the CLI and the primitive advertised a ceiling 20,000× the enforced one.**
`scripts/fleet.ts` bounded `--cap-micro-usd` at a free-floating $1M (1e12 µ$) literal, and
`fanout-primitive.ts`'s shared `invalid-cap` check had no ceiling at all. Post-INV-CAP-1,
`fleet fanout --cap-micro-usd 100000000 --n 3` passed the CLI range check, passed F15
reconciliation, reserved n × $100 of admission headroom, provisioned n BILLABLE boxes, then
every arm died at the mint's `cap-invalid` — real money for work that could never start.

**D2 — the mint failure's structured diagnosis died in the step-7 catch.**
`mintAndDeliverKey`'s catch preserved message + remediation ONLY for `FleetError`; a
`CredentialLifecycleError` (extends `ProviderError`, not `FleetError`) was flattened to a
generic "key mint or delivery failed" + generic INV-5 remediation. Only
`payload.providerCode` survived. The operator-facing remediation written for the refusal
shipped nowhere on this path.

## Fix

**D1 — REFUSE, never clamp, derived from one constant.** Every bound imports
`defaultKeyCapMicroUsd`; the $1M literal is deleted; no numeric copy exists anywhere.

1. `scripts/fleet.ts` CLI parse: `--cap-micro-usd` above the backstop refuses at flag
   validation, before any fanout work, remediation in the mint guard's vocabulary.
2. `fanout-primitive.ts` `validatePatternInput`: the shared seam refuses
   `capMicroUsd > defaultKeyCapMicroUsd` (programmatic callers get the same refusal), and F15's
   reconciliation can never compute `need = n × cap` against a doomed figure (validation runs
   before the lock; a comment states the invariant).
3. `dispatch.ts` B1: the backstop arm refuses PRE-ADMISSION (exit 2, `invalid-cap`), which
   eliminates the stranded-reservation class entirely — zero boxes, zero run records, zero
   admissions.

**D2 — capability-based discrimination, composed remediation.** The step-7 catch now
preserves message (suffixed with the run context, same pattern as the FleetError branch) and
remediation for ANY structured error — string `.remediation` AND string `.code`, the
`ProviderError` family shape, detected by capability not `instanceof`. Remediation is
COMPOSED: the structured remediation first, then the INV-5 record-open/box-alive line — both
independently true for any mint failure. UNCHANGED: exit code 1, the
`key-delivery-refused`/`key-delivery-failed` mapping, `providerCode` payload, and the generic
fallback for unstructured throwables (the "FIXED message" pin at dispatch.test.ts's
mint-throws test stays green by design).

## Acceptance Criteria (= the tests)

- Just-above (`defaultKeyCapMicroUsd + 1`) refused PRE-PROVISION at each layer — CLI exit 2,
  fanout `invalid-cap` exit 2 with zero lock/boxes/records, dispatch `invalid-cap` exit 2 with
  zero boxes/records/admissions.
- Boundary (`defaultKeyCapMicroUsd` exactly) passes through everywhere — CLI exit 0, fanout
  arms complete, dispatch admits and the mint is asked for the backstop as the keyCap.
- Drift-alarm derivation: every test derives its fixture from the IMPORTED constant, so
  editing the number on either side moves the boundary instead of silently forking the layers.
- Refusal text names the knob (`defaultKeyCapMicroUsd`) and its home
  (`src/providers/credentials.ts`).
- AC4 cascade: the round-1 test ("admitted ceiling above the backstop reaches the mint …
  stranding a real box") is REWRITTEN to assert the pre-admission refusal — B1 is not reverted
  to keep the old stranding pin green.
- D2: a structured error's message AND composed remediation (structured first, INV-5 second)
  survive to the refusal; `providerCode` still rides the payload; plain `Error` keeps the
  generic text.

## Dev Agent Record

- Impact (GitNexus, pre-edit): `validatePatternInput` upstream LOW (3 impacted: fanout →
  runFanout → run, all in fleet/fanout/scripts scope); `dispatch` resolved to
  `Function:src/fleet/dispatch.ts:dispatch` upstream LOW (6 impacted; index note: the
  workspace index predates the DF2.13 branch's line shifts — the handoff pre-recorded HIGH;
  actual edit is one guard arm + refusal inside B1).
- Tests: dispatch.test.ts (AC4 rewrite + inclusive-boundary leg), patterns.test.ts
  (over-backstop rows + inclusive fan-out leg), cli.test.ts (C1 trio rewritten around the
  imported backstop), dispatch.test.ts D2 leg.
- Gates: `bunx biome check` exit 0; `bunx tsc --noEmit` exit 0. Focal suites 508/508 (D1),
  then 468/468 after D2. Full suite: 5651 pass / 1 fail across 181 files — the 1 is the
  buildId re-pin gate, red by design on any branch touching a walked image input
  (`src/fleet/`); same expected-red documented in PR #254's own Verification section.
- detect_changes: commit 1 = 4 symbols (runFanout, dispatch, validatePatternInput, fanout),
  15 affected processes, ALL in the fleet/fanout/scripts families; commit 2 = 1 symbol
  (mintAndDeliverKey), LOW, zero affected processes.
- Status: done (evidence in PR #254; commits eb802a6 + f6afc79).
