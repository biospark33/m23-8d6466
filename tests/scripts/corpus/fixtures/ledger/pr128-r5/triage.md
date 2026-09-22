# PR 128 Round 5 — Triage Ledger

Date: 2026-08-24. Reviewers: 9 spawned. 9 reports collected.

## Patch findings

| ID | Sev | Title | Location | Source | Wave |
|----|-----|-------|----------|--------|------|
| P1 | MED | Reap-mutex steal-success path retries claim without tick sleep — CPU spin window | src/fleet/fleet-lock.ts:561-564 | blind-lock | 1 |
| P2 | LOW | `undecided()` called twice per poll iteration — hoist to const | src/fleet/fanout-primitive.ts:534-536 | blind-primitive | 1 |

## Unmatched cell encoding

| ID | Sev | Title | Location | Source | Class |
|----|-----|-------|----------|--------|------|
| N1 | LOW | Bare single-letter code that is in no alias table stays skipped, never guessed | tests/fleet/cli.test.ts | edge-tests-cli | N |

## Dismissed (verified before drop)

| ID | Finding | Source | Dismissal evidence |
|----|---------|--------|--------------------|
| X1 | HIGH: fleetUnwinding TOCTOU on double SIGINT | blind-lock | `onSignal` is fully synchronous; second handler invocation sees flag=true. No interleave window. |
