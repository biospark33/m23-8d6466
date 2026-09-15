# Wave 14 — Verifier A — DF3.7 + DF3.8 (paired)

Reviewer: Wave-14 Verifier A, clean eyes (no prior review material read).
Tree reviewed: branch `dev` at `4264f546` plus the uncommitted spec edits in the working tree.

## Method

Both story files were read end to end. Every named symbol, constant, flag, event, unit
directive, config key, path, fixture and test file was opened at source and the claim was
traced through the real call path, never taken from the citation:

- `src/phase-engine/journal.ts` — `runMarkerRoot`, `runMarkerPath`, `unidentifiedMarkerPath`,
  `assertRunIdPathComponent`, `writeTerminalMarker` (0600, temp+rename, `{runId, ok,
  completedAt}`), the `QDS_RUN_ROOT` no-production-writer note, and `RunOutcome`'s required
  `completedAt` in `src/phase-engine/types.ts`.
- `src/fleet/fanout-primitive.ts` — `boxMarkerPath`, `readMarkerVerdict`,
  `classifyMarkerRead`, `markerUnusableGivesUp`, `MARKER_UNUSABLE_TICKS_LIMIT`,
  `PROBE_SKIP_TICKS_LIMIT`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_PER_CALL_DEADLINE_MS`,
  `DEFAULT_FANOUT_CEILING_MS`, the "INV-6 finite caps (imported constants — never mirrored
  literals)" section heading, the wrong-box-path defect docblock above `boxMarkerPath`, the
  same-tick corroboration rule in `runRace`, `probeArm`, the module's import specifiers.
- `src/fleet/run.ts` — `unitActivity` (signature, `failed`/`inactive`/`unknown` arms, the
  default-branch comment), `startRun` (record read, no write, pre-start guard), `boxText`,
  the module-header "start the unit and return" contract.
- `src/providers/exedev/transport.ts` — `readBoxFile`, `BoxFileRead`'s four kinds, the
  shared-budget exhaustion sentinel, `EXEC_KILLED_EXIT`/`EXEC_TRANSPORT_EXIT`.
- `src/fleet/status.ts` — the `expiredState` import from `approval-gate.ts`, `inBoxState`
  (shared `readMarkerVerdict` + `unitActivity` calls), the read-surface (`create: false`) note.
- `src/fleet/index.ts` — the eight-module star-export block.
- `src/reverify/runner.ts` — `reverify()` in full: `hostRoot`/`runsDir` resolution, the
  `nothing-to-verify` preflight return, the non-green early return, the production
  `recordApprovalPort` build with no `teardown` seam, the bound-`reportId` re-present, the
  approval-request catch, and every `approval: null` producer.
- `src/reverify/approval.ts` — the `../fleet/approval-gate.ts` import, `ApprovalState`
  vocabulary, `recordApprovalPort`, `refuseHollowBundle`.
- `src/fleet/approval-gate.ts` — `GateDeps.teardown` docblock (the caller-must-already-hold
  the run-lock rule and the `RunLockReentrantError` warning), `expiredState` (`pausing`
  never expires), the `TERMINAL` set, `pauseRun` (register `pausing` → R5-C guard →
  INV-APPROVE-6 "ENFORCED rather than asserted" promote-tail guard → teardown outside the
  lock → promote), `refuseLiveInfraOnDecidable`, the resume/rebind reportId+headSha
  byte-compare arms, the promote-race `pause-in-progress` return, `submitDecision`,
  `PauseTimings`/deferred item D8, `emitPause` (`dispatchRequestId`), `withApprovalLock`,
  `withTeardownClaim`.
- `scripts/lib/run-lock.ts` — `acquireRunLock` (the `held.has(lock)` reentrancy guard, the
  resolved-path return, the `RunLockHandle` brand), `RunLockReentrantError`, `RunLockedError`
  (`stale` flag, the `rm` remediation), `withRunLock` (acquire log, destructive posture),
  `moduleState` on `globalThis`, `installSignalRelease`, the ponytail embedder note.
- `src/providers/teardown.ts` — `TeardownDeps` (all three "additions" are optional fields),
  `teardownSandbox`'s required `RunLockHandle` third parameter and `teardown-lock-mismatch`
  head check, the step order (`spend → artifacts → harvest → revoke → verify → destroy →
  close`).
- `src/providers/reaper.ts` — the `stale-record` classification (three sites, one per
  enumeration loop), `aged()` (an arrow over the `staleAfterMs` limit read),
  `record-claim-refused` (guards the destroy unit's re-check only), the teardown unit's
  `withRunLock` holder, the revoke unit (no lock — issue #244's premise confirmed true).
- `src/providers/quota.ts` — `DEFAULT_QUOTA_LIMITS.staleAfterMs` = 14_400_000.
- `scripts/sandbox-reap.ts` — the dry-run-by-default docblock. `scripts/fleet.ts` —
  `runDestructive`'s `acquireRunLock`, the dispatch-mint swallowed lock ("must NOT abort the
  mint"), the gate-verb handler (no run lock anywhere), `runGateVerbs`.
- `src/fleet/verbs.ts` — the `dispatch` summary line, the registry-as-contract comment, the
  `harvest` descriptor's exit-5 note, `harvest`/`teardown` exit tables `[0,1,2,4,5,6]`.
- `src/fleet/dispatch.ts` — `stampCorrelation`, the `within("create", …)` span wrapping
  `store.create`, the budget write AND `driver.create`.
- `src/providers/run-record.ts` — `EXTENSION_NAMESPACES.approval`, `RunRecord`/
  `RunRecordStore` exports. `src/fleet/fleet-lock.ts` exists (cited, not taken).
- `oci/exedev/systemd/qds-run@.service` — `Type=simple`, `Restart=no`,
  `RuntimeDirectory=qds-run/%i/journal qds-run/%i/trace`, `RuntimeDirectoryPreserve=yes`,
  the no-`[Install]` closing block.
- ADR `docs/superpowers/specs/2026-08-31-tier2-placement-adr.md` — ACCEPTED 2026-08-31,
  Appendix A (2026-09-08), Consequence 4, the host-side-by-consequence gate passage, the
  product-claim passage.
- Existence checks: `tests/fleet/approval-gate.test.ts`, `tests/fleet/fanout-primitive.test.ts`,
  `tests/fleet/gate-verbs.test.ts`, `tests/fleet/patterns.test.ts`, `tests/fleet/verbs.test.ts`,
  `tests/providers/exedev/read-box-file.test.ts`, `tests/providers/reaper.test.ts`,
  `tests/fleet/e2e/tier3-race.live.test.ts`, `tier3-reaper`, `tier3-manystories`,
  `tier3-remote-phases`, and the DF2.10 build scan allow-list
  (`tests/providers/exedev/image-assets.test.ts` — exactly `QDS_PI_CATALOG_DIR` and
  `QDS_TEAM_RUNNER`).

**Zero-match claims and their positive controls (identical machinery):**
- "`scripts/pipeline-run.ts` contains the string `approval` zero times" — grep count `0`;
  positive control in the same file with the same invocation: `verdict` counts 38. HELD.
- "F106 … (`src/reverify/worktree.ts`'s `withGuards` note)" — `F106` greps zero matches
  across `src/`, `scripts/`, `docs/`, `tests/` and the root markdown; positive controls:
  `F064` is present in `worktree.ts` itself and `F048` in `fanout-primitive.ts` with the same
  invocation. NOT HELD (finding DF3.7-W14-3). The register item exists only in the sprint
  corpus.
- `engine_boot_anchor` present in `scripts/pipeline-run.ts` (docblock plus emitter). HELD.
- `runMarkerPath` withheld from `src/phase-engine/index.ts` while `runMarkerRoot` is
  exported. HELD.

**Cross-story reads (named seam claims only):** `df2-11-teardown-lock-readonly-ledger.md`
was consulted solely for the `RunLockHandle`/F106-narrowing seam claim recorded in both
stories' headers. No tracker, handoff, seam-ownership, wave/scan report, fix recipe, or
evidence file was opened — including `_bmad-output/evidence/df1-10-probe/…box-env-probe.json`,
which both stories cite; the probe-dependent claims are marked below as accepted-by-policy,
not verified.

**Tests:** one scoped smoke run with the mandated hygiene:
`bun test tests/fleet/verbs.test.ts > /tmp/w14a-verbs.log 2>&1` → exit 0, 97 pass (CR/ANSI
stripped before reading). No bare `bun test`; no gitnexus analyze.

## Findings

| ID | Story | Class | Sev | Finding |
|----|-------|-------|-----|---------|
| DF3.7-W14-1 | DF3.7 | C3 | **HIGH** | **The `gate-refused` `ChainOutcome` arm has no implementable truthful producer, and its two specified producers collide on one observable.** AC5 defines the arm for (a) "a `reverify()` that returned `approval: null` **as a gate decision on a `green` verdict** (no request error flagged: `requestApproval` was reached and declined)" and (b) "the hand-run live-box `pausing`". At source, (a) does not exist: `ApprovalPort.requestApproval` never returns null and never *declines* — its outcome union is `requested \| rebound \| pause-in-progress \| already-decided` (`pauseRun`); every gate decline (bundle gone, live-infra guard, state collision refusal) is a **throw**, not a null. `reverify()` returns `approval: null` from exactly three sites — the `nothing-to-verify` preflight, the non-green early return, and the approval-request catch — all three of which AC5 itself enumerates as the `vetoed` non-gate arms. (b) arrives through the same catch: the gate throws its live-infra refusal, `reverify()` flags `approval-request-failed` (the thrown message is not in the returned contract — the report carries the flag, `failure` stays unset, the message goes only to the step log) and returns null. So the one case AC5 mandates as `gate-refused` presents with exactly the signature AC5's own rule ("a request **error** is not a gate **decision**") routes to `vetoed`, and the described `gate-refused` null (green verdict, no request error flagged) never occurs. A post-chain record re-read cannot disambiguate either: both the live-infra refusal and an ordinary request failure leave the record `pausing`, open, naming infra; and the same resume can also refuse on `assertBundlePresent` (bundle gone — not a live-infra refusal), so even a heuristic re-read would mislabel the mandated `gate-refused-live-infra` payload and its `fleet teardown` remediation. Consequence: a literal implementation ships a dead `gate-refused` arm and reports the mandated gate-refused case as `vetoed`, losing the operator cue; DF3.8's `runs_gate_refused` counter inherits a producer that cannot fire. Not a BLOCKER only because DF3.8's conservation arithmetic still balances (everything lands in `vetoed`) and the reachable population is the admitted hand-run residual. |
| DF3.7-W14-2 | DF3.7 | C3 | MEDIUM | **`ChainOutcome` has no arm for the two non-null, non-registered `ApprovalOutcome` values.** The union defines `driven` as "the chain landed and the gate registered", but `pauseRun` also returns non-null `pause-in-progress` (the promote-race answer, flagged and re-presented) and `already-decided` (a terminal state found at the gate). Reachability at source: `already-decided` is unreachable for the observer's paths (a decision requires an `awaiting-approval` record, which the in-lock pre-flight refuses and which cannot come into existence mid-chain — the gate verbs take no run lock but have nothing decidable against an open record); `pause-in-progress` is reachable only through the story's own admitted unfenced hand-run `scripts/reverify.ts` racing `promoteStrandedPause`'s promote tail. Both are on the residual the stories explicitly decline to fence, and the union as written cannot classify either truthfully — the dev must invent an arm or force a misattribution. |
| DF3.7-W14-3 | DF3.7 | C1 | MEDIUM | **The F106 source citation does not exist.** "F106's one-process-per-invocation precondition (`src/reverify/worktree.ts`)" and "acknowledged in `src/reverify/worktree.ts`'s `withGuards` note — a residual-exposure acknowledgment" (AC5, INV-IBOX-16): the `withGuards` region documents wall-clock/RSS/descendant-sweep guards and a pid-recycling residual in its ponytail note; nowhere does it acknowledge a one-process-per-invocation precondition, and `F106` has zero matches in any tracked source or doc (positive controls above). The behavioral claims built on it (every sanctioned caller is its own OS process; the hand-run caller is unfenced) are independently true, so the rot is evidentiary — but it is load-bearing as the "acknowledgment" two invariants lean on, and a dev who opens the cited file finds a different residual there. Repeated in DF3.8 (AC2c, INV-IBOX-17). |
| DF3.7-W14-4 | DF3.7 | C4 | LOW | The chain's teardown is prose-ordered "harvest → destroy → revoke → `closedAt`" (E2E Slice) and DF3.8 says "harvest, destroy, revoke and `closedAt`"; the shipped step order is spend → artifacts → harvest → revoke → verify → destroy → close (`STEPS`). The load-bearing property (harvest strictly before destroy) holds in both tellings; the prose order is wrong twice. |
| DF3.7-W14-5 | DF3.7 | C4 | LOW | "the three non-optional additions are what `teardownSandbox`'s `TeardownDeps` requires": `keyApi`, `requestId` and `costLedger` are all **optional** fields of `TeardownDeps`; their requiredness is functional (keyApi fail-closed iff the record carries `keyHash`; requestId/costLedger semantic), and the one thing DF2.11 made required — the `RunLockHandle` third positional parameter — is not a `TeardownDeps` field at all. Over-strict wording; the error direction is safe. |
| DF3.7-W14-6 | DF3.7 | C4 | LOW | The Files-to-Modify exit-table gloss enumerates exit 5 as "`run-engine-dead`, `approval-already-registered`, and this verb's own run-lock refusal", omitting `run-already-closed`, which AC5 explicitly maps to exit 5 ("refused before mutation"). Substance agrees; the enumeration is incomplete. |
| DF3.7-W14-7 | DF3.7 | C4 | LOW | The `vetoed` arm "carri[es] the verdict or preflight reason", but its third producer (the approval-request failure) supplies neither — its reason is a flagged request failure. Wording only. |
| DF3.8-W14-1 | DF3.8 | C2 | MEDIUM | **`candidates_skipped` has no defined producer.** The W12-1 clause gives the sweep-complete counter set a conservation identity ("together account for `candidates_enumerated` minus any partial-pass remainder") and every other counter maps to a named per-pass disposition — driven → `runs_observed`, window/liveness-no-verdict → `runs_unsettled`, `failed` → `runs_engine_dead`, six-skip-unreachable → `runs_box_unreachable`, reboot → `runs_lost_to_reboot`, busy/stale lock → `lock_refused`, collected → `completion_unwitnessed`, post-chain → `runs_gate_refused`/`runs_vetoed`. At `maxTicks: 1` each candidate yields exactly one of those dispositions, so no outcome is left for `candidates_skipped` ("the policed benign skip") to count, and the identity cannot balance as specified. If it is meant to be the partial-pass remainder itself, the same sentence that excludes the remainder from the identity contradicts that. The AC4 negative controls police folding refusals *into* it but never say what legitimately lands there. |
| DF3.8-W14-2 | DF3.8 | C3 | MEDIUM | Inherits DF3.7-W14-1: `runs_gate_refused`'s specified producer is unreachable through the shipped `reverify()` null contract; every real gate decline lands in `runs_vetoed`, so the "two post-chain outcomes" distinction the Observability Contract polices is one the return contract cannot express. |
| DF3.8-W14-3 | DF3.8 | C1 | LOW | The `RunLockedError` cite for "carries the `rm` line for the dead-holder case" points at the class's field block; the `rm` remediation is composed in the constructor body just past it. Substantively true — the `stale` flag exists and drives exactly that remediation. |
| DF3.8-W14-4 | DF3.8 | C4 | LOW | F106 citation rot inherited (see DF3.7-W14-3). |

## What HELD (the load-bearing spine, all verified at source)

**DF3.7.** The marker contract is exactly as specified: `writeTerminalMarker` emits
`{runId, ok, completedAt}` at 0600 by temp+rename, `RunOutcome.completedAt` is a required
string, and the shared classifier reads only `runId` and `ok`. The three-way grammar holds:
`runMarkerPath`/`runMarkerRoot` box-side, `boxMarkerPath` host-side,
`assertRunIdPathComponent` shared, `runMarkerPath` withheld from the phase-engine barrel,
and `fanout-primitive.ts`'s import specifiers name no marker-path symbol (prose mention
only). The classifier's verdict vocabulary, both streak limits (3 and 6), the 5 s/10 s/1 h
constants, the "INV-6 finite caps" heading, the same-tick corroboration rule and the 90 s
arithmetic all match. The single-run observer's rule set (255/137 are `skip`, a `cat`
refusal is `unusable`, `expectedRunId` on every read, `ok:false` is not a veto) is exactly
what `classifyMarkerRead`/`readMarkerVerdict` ship. `unitActivity`'s four readings and the
never-loaded-unit comment are as quoted; `fleet status` and `fleet run` share it as code,
and the status reads go through the same `readMarkerVerdict` + `boxMarkerPath`.
`requestApproval`'s sole production caller is the `reverify()` call site reached from
`scripts/reverify.ts`'s single entry; the production port is built with no `teardown` seam;
the terminal-state vocabulary, `expiredState`'s `pausing` non-expiry, the INV-APPROVE-6
"ENFORCED rather than asserted" promote-tail guard, `refuseLiveInfraOnDecidable`, the R5-C
keyHash guard, and the register-`pausing`-before-teardown ordering all compose the story's
ordering claim correctly (the record is closed before the seam-less promote can run).
The `RunLockHandle` story is exact: `acquireRunLock` returns the resolved path branded as
the handle, the reentrancy guard is the `held.has(lock)` head check, `withRunLock` passes
the handle to a `teardownSandbox` whose head check refuses a foreign lock, and the gate's
`GateDeps.teardown` docblock already prescribes exactly the production wiring DF3.7's
tracked follow-up commits to. The zero-"approval" claim in `scripts/pipeline-run.ts` held
under positive control. Reaper Deviation 1 is **correct and verified**:
`record-claim-refused` guards the destroy unit only, `stale-record` → `teardown` fires from
three classification sites with no `reverify()` in between, `aged()` reads
`staleAfterMs` (4 h default), and the reaper is dry-run by default. The unit file carries
`Type=simple`, `Restart=no`, the per-run `RuntimeDirectory`, `RuntimeDirectoryPreserve=yes`,
and the no-`[Install]` policy block, exactly where cited. The DF2.10 image scan allow-lists
exactly the two named variables. All cited test files exist.

**DF3.8.** Deviation 1's correction is right at source. The `harvest` exit-5 note reads
"the run lock refused, so the verb never ran — refused before provisioning" as quoted; the
dispatch-mint lock acquisition is swallowed with "must NOT abort the mint" as quoted; the
gate verbs take no run lock anywhere in their handler. The reaper's teardown unit holds the
run lock through `withRunLock` (the DF2.11 claim) while its revoke unit does not — issue
#244's premise is true at source, so the header follow-up is correctly scoped. The lock
module matches every claim: process-global `held` map and signal release on `globalThis`,
the ponytail embedder note verbatim, `RunLockedError`'s `stale` flag, `acquireRunLock`'s
resolved-path return. `store.create` precedes `driver.create` inside `provisionAdmittedRun`'s
`within("create", …)` span, so AC4(a)'s "first boot always postdates `createdAt`" and the
millisecond-side inequality are correctly motivated. `Restart=no` and the no-`[Install]`
block make the reboot/liveness indistinguishability claim true. The six-skip streak is
indeed unreachable at `maxTicks: 1`, so the sweep's own `sweep-box-unreachable` disposition
is necessary, not decorative. `engine_boot_anchor` exists as cited; the shipped tier-3 live
files exist; the exit table `[0, 1, 2, 4, 5, 6]` matches the shipped `harvest`/`teardown`
descriptors, so `--all` minting no new code is realizable.

**Probe-dependent claims accepted by policy, not verified:** the box-env probe's tmpfs/`$HOME`/
PID-1 facts and the measured 238-byte image marker (both stories cite the df1-10 probe
evidence, which is a forbidden input for this reviewer). Nothing else in either story's
argument rests solely on those facts: the tmpfs claims are independently asserted by the
unit file and `journal.ts`, and `readBoxFile`/`/proc/uptime` behavior is gated on the live
tests the stories themselves mandate.

## Verdicts

- **DF3.7 — NOT CONVERGED.** One HIGH (C3): the `gate-refused` arm's producers as specified
  do not exist in the shipped `reverify()`/gate return contract, and the one mandated
  gate-refused case is indistinguishable from the `vetoed` arm by the data `reverify()`
  returns. One MEDIUM C3 (union cannot classify `pause-in-progress`/`already-decided`), one
  MEDIUM C1 (F106 citation rot), four C4-LOW. Confidence: HIGH (both halves traced through
  `reverify()`, `ApprovalPort`'s outcome union, `pauseRun`'s arms, and the runner's catch).
- **DF3.8 — NOT CONVERGED.** It inherits DF3.7's HIGH through the shared `ChainOutcome`
  contract (its `runs_gate_refused` counter has no reachable producer), and adds one MEDIUM
  C2 (`candidates_skipped` has no producer, so the sweep-complete conservation identity
  cannot balance as written). Confidence: HIGH on the lock/reaper/counter tracing, MEDIUM on
  the `candidates_skipped` intent (a remainder reading is arguable but contradicted by the
  identity's own wording).

## Summary counts

| Story | BLOCKER | HIGH | MEDIUM | LOW | C1 | C2 | C3 | C4 |
|-------|---------|------|--------|-----|----|----|----|----|
| DF3.7 | 0 | 1 | 2 | 4 | 1 | 0 | 2 | 4 |
| DF3.8 | 0 | 0* | 2 | 2 | 1 | 1 | 1 | 1 |

\* DF3.8 carries the DF3.7 HIGH through the shared contract rather than minting its own.

**Ranked blocking items:** (1) DF3.7-W14-1 — re-derive the `gate-refused`/`vetoed`
classification from what `reverify()` actually returns (either give the observer a real
gate-decision signal, e.g. a post-chain record signature the two cases do not share, or
merge the arms and re-aim the exit-6/remediation mapping); (2) DF3.8-W14-1 — define the
disposition that increments `candidates_skipped` or fold it into the remainder;
(3) DF3.7-W14-2 — give the union an arm (or an explicit mapping) for the two non-null,
non-registered approval outcomes; (4) DF3.7-W14-3 — replace the F106/`worktree.ts`
acknowledgment citation with the real register location or drop the evidentiary claim.
