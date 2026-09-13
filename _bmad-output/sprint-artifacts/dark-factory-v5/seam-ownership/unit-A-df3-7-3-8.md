# Seam-ownership table — Unit A: DF3.7 (writer) + DF3.8 (caller)

Wave 7 rework artifact. Charter: `2026-09-10-wave7-HANDOFF.md` §4(ii). Worklist: `wave6-A-df3-7-df3-8.md`.
Rule: every deliverable, file, call site, flag, AC, test and edit is listed **once** with **exactly one owner**.
The specs were reconciled to this table in the same commit that landed it.

## Contract seam

DF3.7 **writes/owns** the observe primitive and the chain composition; DF3.8 **consumes** it as a
second caller. Crossing surface: `observeAndDriveChain(runId, deps)` + `promoteStrandedPause(runId, deps)`
+ the `ChainOutcome` union, defined in `src/fleet/run-completion.ts` (DF3.7), consumed unchanged by
`src/fleet/observe.ts` (DF3.8). One JSON payload shape crosses the pair seam; no prose restates the mapping.

## Ownership

| # | Deliverable | Owner (exactly one) |
|---|---|---|
| O1 | `src/fleet/run-completion.ts` — `observeAndDriveChain`, `promoteStrandedPause`, the `ChainOutcome` union (`driven` / `unsettled` / `refused` / `gate-refused`), the deps shape `{driver, store, runsDir, hostRoot, runLock, maxTicks?, windowMs?}` | DF3.7 |
| O2 | `fleet observe <run-id>` verb descriptor + full exit table `[0,1,2,4,5,6]` in `src/fleet/verbs.ts` (DF3.1-owned file; adds-only) | DF3.7 |
| O3 | The single-run verb's own `withRunLock` acquisition in the `scripts/fleet.ts` `observe` block, producing `deps.runLock` (W6-A-M5) | DF3.7 |
| O4 | The typed refusal prints for the single-run form (`run-completion-unobserved`, `run-engine-dead`, `box-unreachable`, `gate-refused-live-infra`, `approval-already-registered`) | DF3.7 |
| O5 | `tests/fleet/run-completion.test.ts` — classifier verdicts, both streaks, liveness arm, `boxMarkerPath` derivation, unobserved arm, pre-flight refusal incl. `pausing`, AC1 import fence, the verb's lock-before-preflight ordering | DF3.7 |
| O6 | `tests/fleet/e2e/tier2-run-completion.live.test.ts` | DF3.7 |
| O7 | The AC1 static import fence **definition** (over `src/fleet/run-completion.ts`) | DF3.7 |
| O8 | The fence **extension** to `src/fleet/observe.ts` (same grep, second target) | DF3.8 |
| O9 | `--all` flag on DF3.7's verb descriptor + the sweep path in `scripts/fleet.ts` | DF3.8 |
| O10 | `src/fleet/observe.ts` — candidate enumeration, per-run lock discipline, in-lock pre-flight re-read, reboot measurement, per-pass dispositions | DF3.8 |
| O11 | The documented cron line and the `--help` host-root wording (no temporary reap warning — W6-A-H2) | DF3.8 |
| O12 | `tests/fleet/observe.test.ts` | DF3.8 |
| O13 | `tests/fleet/e2e/tier3-observe-detached.live.test.ts` | DF3.8 |
| O14 | The `sweep-complete` counter set and its accounting identity (`runs_observed`, `runs_unsettled`, `runs_engine_dead`, `runs_box_unreachable`, `runs_lost_to_reboot`, `lock_refused`, `completion_unwitnessed`, `candidates_skipped`; measurements `box_reboot_after_dispatch`, `uptime_unknown` cut across) | DF3.8 |
| O15 | The per-pass `box-unreachable` disposition (distinct counter, one typed line, reported-not-retired) (W6-A-M1) | DF3.8 |
| O16 | `sprint-status.yaml` DF3.7 + DF3.8 row prose | parent (W6-A-M7) |
| O17 | The DF2.11 edge strength (hard predecessor; **landed**) — stated once per story, canonical form in the yaml | parent (W6-A-H2) |
| O18 | `scripts/lib/run-lock.ts` ponytail-note comment retirement (the note's embedder trigger is realized by this story) — comment-only edit; the story's dev moves the image pin anyway via `src/fleet/observe.ts` | DF3.8 (W6-A-H2 orphan) |
| O19 | Issue #245 (GateDeps.teardown closure) and #244 (revoke-unit lock) follow-ups | existing header blockquotes (unchanged) |
| O20 | The `startedAt` run-record stamp seam question | arc owner, DF1.10 seam (existing Technical Notes flag) |

## Reconciliations applied (Wave 6 → spec)

| Finding | Disposition |
|---|---|
| W6-A-H1 (C3) | **Deleted, option (b).** A collected record is always `completion-unwitnessed`; `markerWitnessed` dropped from `ChainOutcome` (no producer of `true` exists at the single permitted observation point); DF3.8 AC3's re-entry branch and the DoD test item go with it. Rationale recorded in the tracker Wave-7 section. |
| W6-A-H2 (C3) | **One reading.** DF2.11 is a landed hard predecessor (yaml is canonical). DF3.7's merge-ordering hedge deleted; DF3.8's "not a predecessor" sentence deleted; AC2(e) rewritten (the reaper is a `withRunLock` holder — verified at `src/providers/reaper.ts`, which calls `withRunLock(..., (h) => teardownSandbox(teardownDeps, unit.id, h))`); the temporary `--help` reap warning and AC3's "once DF2.11 lands" clause deleted; INV-IBOX-18's cost paragraph rewritten as "closed by DF2.11"; the `run-lock.ts` ponytail-note retirement gets an owner (O18). |
| W6-A-M1 (C3) | **Fixed.** Sweep gains the `runs_box_unreachable` disposition (O15); "two permanently-refusing cases" corrected to three; AC6's `box-unreachable` line is now true (own counter). |
| W6-A-M2 (C2) | **Fixed.** AC5 cites `pauseRun`'s enforced INV-APPROVE-6 guard ("ENFORCED rather than asserted", the `teardown === undefined` condition), not `refuseLiveInfraOnDecidable` (which runs only on the rebind and decide arms); "post-teardown by construction" → "post-teardown on every path this story or DF3.8 drives", with the hand-run live-box `pausing` case admitted; `ChainOutcome` gains the `gate-refused` arm (`gate-refused-live-infra`, remediation names `fleet teardown <runId>`), mapped to exit 6. |
| W6-A-M3 (C2) | **Fixed in both stories.** "The marker's bytes are never echoed" restated truthfully: a verdict's `code` and `error` are logged only through `redactSecrets` and capped, in the `probeArm`/`boxText` idiom — the shipped classifier builds those errors out of the marker's own bytes. |
| W6-A-M4 (C3) | **Fixed.** The reboot comparison is written once, in one unit: `uptimeMs = Math.round(uptimeSeconds * 1000)`; reboot iff `uptimeMs < (hostNow − createdAt) − PROVISION_LAG_MARGIN_MS`; the evidence JSON carries `provisionLagMs` alongside raw `uptimeSeconds`. AC4(a), AC4(b), the negative controls, the Technical Notes evidence sentence and the DoD test all use it. |
| W6-A-M5 (C3) | **Fixed.** The single-run verb acquires `<runsDir>/<runId>.lock` via DF2.11's `withRunLock` **before** the pre-flight record read and passes the handle as `deps.runLock` (O3); the AC, the DoD item, the test and the exit-5 annotation (this verb's own refusal, inherited by `--all`) all name it. |
| W6-A-M6 (C2) | **Fixed in both stories.** The lock prevents concurrent chains on one run (double teardown / double harvest / double `requestApproval`); F106's one-process-per-invocation precondition is preserved by AC2(a)'s serial pass; only a future concurrent-within-one-process caller re-opens it. The AC2(c) negative control no longer claims two cron tick processes can make F106 live. |
| W6-A-M7 (C1) | **Fixed by parent.** Both yaml rows' prose rewritten against the merged story text (see the tracker Wave-7 section for the before/after). |
| W6-A-L1 (C1) | **Fixed.** `completedAt?` re-argued from `classifyMarkerRead` (reads exactly `runId` and `ok`); the shipped writer always emits three fields, so optionality is tolerance, not an expected shape. The `JournalFile` justification is gone. |
| W6-A-L2 (C1) | **Fixed by symbol.** `:951`/`:952` line cites stripped everywhere; the reentrancy fact cites `RunLockReentrantError` and the guard at the head of `acquireRunLock`. |
| W6-A-L3 (C4) | **Fixed.** "No `QDS_*` path variable" narrowed to `QDS_RUN_ROOT`/`QDS_STEERING_ROOT`, with the AC6 build scan's two-name allow-list (`QDS_PI_CATALOG_DIR`, `QDS_TEAM_RUNNER`) named. |
| W6-A-L4 (C4) | **Fixed.** The accounting identity is stated over the disposition set only; `box_reboot_after_dispatch`/`uptime_unknown` are named as cross-cutting measurements; `candidate-skipped` gets the `candidates_skipped` counter. |
| W6-A-L5 (C4) | **Fixed.** AC5 names `ApprovalState` from `src/reverify/approval.ts` as the terminal-state vocabulary and records that `expiredState` is deliberately not applied (both readings refuse). |
| W6-A-L6 (C1) | **Fixed.** The boot/uptime anchor is cited as `scripts/pipeline-run.ts`'s `engine_boot_anchor` by symbol, noting it moves in-box with DF1.10 — not DF1.11. |
