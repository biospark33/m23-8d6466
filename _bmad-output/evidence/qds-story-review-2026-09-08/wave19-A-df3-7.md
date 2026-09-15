# Wave 19-A — Verifier report: DF3.7 (Approval-Gate Bridge — Run-Completion Signal for In-Box Runs)

**Story:** `_bmad-output/sprint-artifacts/dark-factory-v5/stories/df3-7-approval-gate-bridge.md`
**Reviewed state:** branch `dev` @ `4264f546` plus uncommitted spec edits (working tree as-is).
**Verdict: NOT CONVERGED — 1 BLOCKER / 0 HIGH / 2 MEDIUM / 5 LOW. Confidence: HIGH.**

---

## Method

Read the story end to end, then opened at source every symbol the spec names and traced the call
paths rather than trusting citations:

- **Control flow under the primary lens:** `reverify()` in `src/reverify/runner.ts` (every return
  arm: nothing-to-verify early return, failure-report return, green + approval-catch return,
  green + `pause-in-progress`/`already-decided`/`rebound`/`requested` returns, and every throw
  site reachable after `closedAt` is set); `ApprovalOutcome`/`ApprovalState` in
  `src/reverify/approval.ts`; `recordApprovalPort` and its not-passed `teardown` seam;
  `TERMINAL`, `expiredState`, `emitPause`, `PauseTimings`, `pauseRun`'s INV-APPROVE-6 block and
  the plain-`Error` refusal throws in `src/fleet/approval-gate.ts`; `teardownSandbox` step array,
  `closedAt` refusal and `TeardownDeps` in `src/providers/teardown.ts`.
- **Classifier/poll surface:** `readMarkerVerdict`, `classifyMarkerRead`, `markerUnusableGivesUp`,
  `MARKER_UNUSABLE_TICKS_LIMIT`, `PROBE_SKIP_TICKS_LIMIT`, `DEFAULT_POLL_INTERVAL_MS`,
  `DEFAULT_PER_CALL_DEADLINE_MS`, `boxMarkerPath`, `BOX_MARKER_PATH_RE`, `probeArm`, `runRace`
  (its `anyArmAnswered || current.length === 1` corroboration rule) in
  `src/fleet/fanout-primitive.ts`; `readBoxFile`/`BoxFileRead` in
  `src/providers/exedev/transport.ts`; `unitActivity` in `src/fleet/run.ts`; the shared calls in
  `src/fleet/status.ts`.
- **Locks, verbs, record, ledger:** `RunLockReentrantError`/`acquireRunLock` guard/`withRunLock`
  in `scripts/lib/run-lock.ts`; `listVerbs` dispatch/registry entries in `src/fleet/verbs.ts`;
  the approval-extension registration in `src/providers/run-record.ts`; `stampCorrelation` in
  `src/fleet/dispatch.ts`; `CostLedger` in `src/providers/cost-ledger.ts`; `openRouterKeyApi` in
  `src/providers/credentials.ts`; the no-mint posture of `src/fleet/resident.ts`; the F064
  `withGuards` descendant sweep and the second-reverify residual comment in
  `src/reverify/worktree.ts`.
- **Reaper/quota arms AC3 names:** `record-claim-refused` (destroy-guard branch only) and
  `stale-record` → `action: "teardown"` (all three classification sites) in
  `src/providers/reaper.ts`; `staleAfterMs: 14_400_000` in `src/providers/quota.ts`.
- **Box leg:** `runMarkerRoot`/`runMarkerPath`/`unidentifiedMarkerPath`/
  `assertRunIdPathComponent`/`writeTerminalMarker` and the "no production writer" passage in
  `src/phase-engine/journal.ts`; the barrel withholding in `src/phase-engine/index.ts`;
  `Type=simple`/`Restart=no`/`RuntimeDirectory=qds-run/%i/…`/`RuntimeDirectoryPreserve=yes` in
  `oci/exedev/systemd/qds-run@.service`.
- **Fence claims:** `src/reverify/approval.ts` imports `requestApproval` from
  `../fleet/approval-gate.ts`; `src/fleet/index.ts` star-exports exactly eight fleet modules
  including `status.ts`; `src/fleet/status.ts` imports `expiredState` from
  `./approval-gate.ts`; fan-out's import specifiers carry no marker-path symbol (read, not
  grepped); `deriveVerdict`'s `red`/`nothing-to-verify` mapping in `src/reverify/report.ts`.

**Zero-match claims, each with a positive control on identical machinery:**

| Claim | Machinery | Result | Control |
|---|---|---|---|
| `scripts/pipeline-run.ts` contains `approval` zero times | `grep -c` | 0 | same grep on `scripts/fleet.ts`: 38 hits — machinery proven |
| `scripts/pipeline-run-remote.ts` deleted | `ls`/grep | absent | same invocation located every other named script |
| `requestApproval`'s sole production caller is `reverify()` | repo-wide grep of `src`+`scripts`, tests excluded | only `runner.ts`'s `port.requestApproval` call; every other hit a comment | the grep found the caller itself, proving it is not blind |
| fan-out's import specifiers name no marker-path symbol | full read of the import block | confirmed — it imports `boxRunRoot` and defines `boxMarkerPath`; `runMarkerPath()` appears in prose only | n/a (read, not grep) |

**Cross-story reads (seam claims only, as permitted):** DF2.11's lock record for the
eighth-`teardownSandbox`-call-site assignment (confirmed: DF2.11 assigns the eighth call site to
DF3.8's sweep, so DF3.7's chain is "simply another caller holding the lock itself" — accurate);
DF3.8's story for `PROVISION_LAG_MARGIN_MS` pricing precedent and the collected-record/refuses-
unconditionally references (present as cited). DF5.1's surface was verified entirely in code.

**Tests (scoped, logged, stripped):**

- `bun test tests/fleet/fanout-primitive.test.ts tests/providers/exedev/read-box-file.test.ts`
  → `/tmp/w19-a.log`: **42 pass / 0 fail**.
- `bun test tests/fleet/approval-gate.test.ts` → `/tmp/w19-b.log`: **151 pass / 0 fail**.

No bare `bun test`, no `gitnexus analyze`, no file edited other than this report.

---

## Primary lens — the ChainOutcome union vs the shipped control flow

Full enumeration of what the chain can produce, and where each lands in the union as written:

| Chain reality (verified at source) | Union arm | Carried? |
|---|---|---|
| `reverify()` returns `{report, approval:{outcome:"requested"}}` | `driven` (+`markerOk`, `chainMs`) | yes |
| `reverify()` green, gate returns `pause-in-progress`/`already-decided`/`rebound` | `handed-off` | yes — matches the shipped non-request arms exactly; `requested` correctly excluded |
| `reverify()` returns `approval:null` on a non-green verdict (including `error` failure reports and `red`/`nothing-to-verify`) | `vetoed` | yes — `report.reason` exists and carries each cause; discriminable from approval-failed because only the green path can set `approval-request-failed` |
| `reverify()` green, approval-request catch flattens to `approval:null` + flag | `approval-failed` | partially — see W19-3 |
| a `reverify()` throw after `closedAt` (the report leg: `readReports`/`seal`/`appendReport` sit outside the body's try/catch, and the catch's own re-seal/append can throw) | `chain-failed` | yes — reachable as claimed |
| a `teardownSandbox` step failure post-close | `chain-failed` | yes |
| **`{code:"box-unreachable", message, remediation}` at exit 1 (AC2a skip-streak fill)** | **none** | **no — W19-1** |
| **`{code:"run-completion-unobserved", message, remediation}` at exit 1 (AC3 window / unusable-streak fill)** | **none** | **no — W19-1** |
| **`{code:"run-engine-dead", message, remediation}` at exit 5 (AC2d)** | **none** | **no — W19-1** |
| `unsettled` | — | no producer anywhere in the story |

The pre-flight order (extension refusal → `pausing` route to `promoteStrandedPause` → `closedAt`
refusal) matches reachability and I could not break it: an `awaiting-approval` record necessarily
carries `closedAt` (teardown's close step precedes the gate), so extension-before-`closedAt` is
load-bearing and is what the text orders; a `pausing` record also carries `closedAt`, hence the
explicit `closedAt`-after-`pausing` ordering; and `pausing` is disjoint from the extension
refusal set, so the extension check can never pre-empt the promote route. `expiredState` is
correctly not applied: the shipped rule maps an expired `awaiting-approval` to `timed-out`, both
of which refuse, so label-only. The deps shape feeds every composition: `teardownSandbox`'s
`TeardownDeps` (driver, store, keyApi, requestId, costLedger, runsDir), `reverify`'s
`ReverifyDeps` (hostRoot, runsDir, store), the lock handle, and the marker poll (driver,
windowMs/maxTicks) — every field is consumed; only the wording of one justification is off
(W19-7). The union carries no survivor of any earlier vocabulary — no `markerWitnessed`, no
second expiry clock, no approval field — and the deliberately-absent-field reasoning checks out
against DF3.8's always-`completion-unwitnessed` collected-record arm.

---

## Findings

| ID | Class | Severity | Finding |
|---|---|---|---|
| DF3.7-W19-1 | C3 | **BLOCKER** | **The union's arm set cannot express three terminal outcomes the story mandates, and `unsettled` has no producer.** `observeAndDriveChain` returns `Promise<ChainOutcome>`, so every outcome is one of the seven arms. AC2(a) mandates a typed `{code:"box-unreachable", message, remediation}` at exit 1; AC3 mandates `{code:"run-completion-unobserved", message, remediation}` at exit 1 (window expiry *and* the unusable-streak abandonment, which AC2 routes "to AC3's arm"); AC2(d) mandates `{code:"run-engine-dead", message, remediation}` at exit 5. The only arm with that shape is `refused`, but the story scopes `refused` to exit-5 pre-flight refusals — the exit table defines 5 as "refused before anything was mutated…" naming `run-engine-dead`/`approval-already-registered`/the lock refusal, and the Observability kind list assigns `refused` exactly two codes (`approval-already-registered`, `run-already-closed`) and assigns `box-unreachable`/`run-completion-unobserved`/`run-engine-dead` no kind at all. The remaining arm, `{kind:"unsettled"; verdict: MarkerVerdict}`, carries no code/message/remediation field, and no sentence in the story ever produces it. Under the only alternative reading — `unsettled` is the exit-1 carrier and the CLI mints the typed payload — the union cannot distinguish the two exit-1 causes when the window expires on a skip tick: the last verdict is `skip` (with its own neutral code) in both cases, so the caller must re-derive which bound fired, defeating the union's own stated purpose ("count and log without re-deriving") and collapsing exactly the pair AC2(a) forbids conflating ("a distinct code from AC3's `run-completion-unobserved`… conflating the two tells an operator the host never looked when in fact the box never answered"). No assignment satisfies the union definition, the exit table, the Observability kind list and AC5's negative controls simultaneously; the negative controls contain no case that would catch a wrong choice. Fix is one spec sentence: give the three typed outcomes a home (extend `refused` to carry all five typed codes with the exit derived from the code, or add a `cause` discriminator to `unsettled` and name its producer). |
| DF3.7-W19-2 | C3 | MEDIUM | **`vetoed` has no exit code.** The verb's exit table `[0,1,2,4,5,6]` maps 6 to "the CLI's own output or cleanup, or the approval leg failing (`approval-failed`, AC5)" — `vetoed` is in neither the table nor AC5's prose. The DoD item ends "…reports `{kind:"vetoed", reason}` … and the gate's non-null … outcomes report `{kind:"handed-off", outcome}` **at the same exit 6**", whose scope is ambiguous (handed-off only, or all three arms) and which, read broadly, contradicts the exit table's 6 description. An operator-facing verb cannot ship an arm whose exit is unspecified. One sentence fixes it. |
| DF3.7-W19-3 | C2 | MEDIUM | **`approval-failed`'s `error` string has no stated carrier.** AC5 says the arm carries "the thrown error's message", but the shipped contract the story itself describes flattens that throw: `reverify()`'s approval-request catch pushes the generic `approval-request-failed` flag and returns; the message reaches only `reverify`'s `log` sink (the `step("approval", …, {outcome:"failed", error})` event). The chain *can* recover it by passing its own sink into `ReverifyDeps.log` — but no sentence wires that, and a dev reading the returned `ReverifyOutcome` finds only the flag. As written the arm's payload is implementable only by an unspecified mechanism, or it degenerates to carrying the flag name. State the log-sink capture (or accept that `error` is the flag text). |
| DF3.7-W19-4 | C4 | LOW | **Teardown's step order is misquoted twice.** The E2E slice says "runs `teardownSandbox` (harvest → destroy → revoke → `closedAt`)" and the Technical Notes ordering line repeats "harvest/destroy/revoke/`closedAt`". The shipped `STEPS` array is stopVisualizer → spend → artifacts → harvest → **revoke → verify → destroy** → close: revoke precedes destroy. No behavioral consequence (composition only — the chain calls the function and re-implements nothing), but the story states the shipped sequence it depends on incorrectly in two places. |
| DF3.7-W19-5 | C2 | LOW | **AC2(a) mischaracterizes the corroboration rule it differentiates from.** "fan-out applies this limit only when something answered on the same tick" — `runRace` acts on a filled skip streak when *anything answered* **or** the starved arm is the last undecided one, and the last-undecided case has no wall-clock floor. A single-run observer is always the last undecided arm, so fan-out's rule consumed as-is would abandon at six skips with no 90 s gate. The observer's own stated rule (six consecutive skips **and** ≥ `PROBE_SKIP_TICKS_LIMIT × (DEFAULT_POLL_INTERVAL_MS + DEFAULT_PER_CALL_DEADLINE_MS)`; the 90 s arithmetic checks out) is deliberately stricter and is fine — but the sentence describing the mechanism it departs from is wrong, and a dev told the streak logic is "the same-tick corroboration rule" may import the looser variant. (Consuming the streak itself is not a violation of DF1.10 AC5 — `runRace` is private and the story correctly claims only the classifier as shared code.) |
| DF3.7-W19-6 | C3 | LOW | **One `requestId` dep slot, two mandated roles.** Observability: the observer's own lines carry the *invoking process's* requestId; the chain/gate path carries the *record's* `dispatchRequestId` ("the join key is always the record's"). Files-to-Modify: `deps.requestId` is "from the pre-flight record read" — the record's (correct for `TeardownDeps` propagation and the gate). The invocation's requestId, which the module's own `{event:"run-completion", …}` lines are mandated to carry, has no dep and no stated source. Either split the field or state that the CLI prints the observer's lines. |
| DF3.7-W19-7 | C4 | LOW | **"The three non-optional additions are what `TeardownDeps` requires" overstates the interface.** `TeardownDeps` declares `keyApi?`, `requestId?`, `costLedger?` all optional (`keyApi` "Required iff the record carries keyHash (fail-closed otherwise)"). The requirement is semantic — pricing without a ledger silently under-counts box hours, keyed records fail closed without a key — and making them non-optional in this story's deps is right; only the justification sentence misstates where the requirement lives. |
| DF3.7-W19-8 | C4 | LOW | **"which `run-completion.ts` imports anyway" (for `src/reverify/approval.ts`) is asserted, not established.** Nothing else in the design gives the new module a reason to import it: the state check is a string comparison, `ChainOutcome` names no `ApprovalState`, and `reverify()` is reached via `runner.ts`. Harmless — the fence permits the import (direct specifiers only, and this is not one of the four banned specifiers) — but it presents an implementation detail as a fact about a module that does not exist yet. |

---

## What HELD

- **The primary lens's core mapping is sound where the union is defined.** Every `reverify()`
  return arm and post-close throw path maps to exactly one arm with a carried discriminator:
  `requested`→`driven`; the shipped non-request non-null arms (`pause-in-progress`,
  `already-decided`, `rebound`)→`handed-off` with no earlier-vocabulary survivor; non-green null
  (red, error, `nothing-to-verify` — all non-green under `deriveVerdict`)→`vetoed` with
  `report.reason` as cause; green null + flag→`approval-failed`; report-leg and teardown-step
  throws post-`closedAt`→`chain-failed`. The vetoed/approval-failed discriminator (verdict + the
  `approval-request-failed` flag) is derivable from the returned report.
- **AC5's pre-flight order is reachable-correct** (extension → `pausing` promote → `closedAt`),
  and the `pausing`-implies-`closedAt` reasoning matches the shipped gate: `pauseRun` runs the
  real teardown before promoting, INV-APPROVE-6 is "ENFORCED rather than asserted" as quoted, and
  `teardownSandbox` itself refuses an already-closed record — so `run-already-closed` fires
  before any box is touched.
- **AC2's classifier claims are all literally true of `classifyMarkerRead`/`readMarkerVerdict`:**
  the four verdicts, `skip` for every non-clean probe exit, the unusable enumeration
  (budget-exhausted, read-failed, oversized, unparseable, null/primitive body, invalid-typed and
  empty `runId`, mismatch) with `markerUnusableGivesUp` at 3, `expectedRunId` mismatch → 
  `marker-run-mismatch`, the shared-code requirement with `fleet status` and `probeArm` satisfied
  by the same function, and the skip-streak reasoning (with the W19-5 wording caveat).
- **AC2(d) matches `unitActivity` exactly:** `active`/`failed`/`inactive`/`unknown` semantics,
  the default-branch comment quoted accurately, transport failures → `unknown`, and the
  `Type=simple` + `Restart=no` unit facts verified in the unit file alongside the per-run
  `RuntimeDirectory` and `Preserve=yes`.
- **AC4's three-derivations-of-one-grammar** is exactly what the sources show: `boxMarkerPath`
  derives from `boxRunRoot`, `runMarkerPath`/`writeTerminalMarker` are box-side and withheld from
  the phase-engine barrel, the historical-defect docblock exists verbatim in fan-out, and
  `assertRunIdPathComponent` is exported for the host mirrors.
- **AC1's fence surface is accurate in every particular:** the four banned specifiers exist;
  `src/fleet/index.ts` star-exports exactly eight fleet modules including `status.ts`; `status.ts`
  imports `expiredState` from `approval-gate.ts` while re-exporting none of the gate's symbols;
  `approval.ts` imports `requestApproval` from the gate (the sanctioned transitive reach); the
  `RunRecordStore`/`RunRecord` carve-out is real (the extension writer is the gate, not the
  store module's own surface); fan-out's import block names no marker-path symbol.
- **AC3's hazard chain is verified at source:** `record-claim-refused` guards the destroy branch
  only; `stale-record` classifies to `action:"teardown"` at all three enumeration sites
  (VM, key, record); the staleness default is 4 h. The "no existing timer covers this run" claim
  and the reaper's dry-run default are consistent with the reaper as shipped.
- **AC1/INV-IBOX-14's zero-line claim has a live reference point:** `requestApproval`'s sole
  production caller is `reverify()`, `scripts/pipeline-run.ts` contains `approval` zero times
  (positive-controlled), and `pipeline-run-remote.ts` is gone.
- **Observability details hold:** `emitPause` emits `event:"pause"` carrying `dispatchRequestId`;
  `teardown_at_pause_ms` is present only when the seam ran (absent, not zeroed); `stampCorrelation`
  is the record-side stamp; `redactSecrets` is in the log path of the idiom the story cites;
  `resident.ts` mints nothing and borrows the dispatch-minted key.
- **DF2.11/DF3.8 seam references check out:** DF2.11's record assigns the eighth
  `teardownSandbox` call site to DF3.8's sweep (so DF3.7 claims no ordinal — correct); DF3.8's
  `PROVISION_LAG_MARGIN_MS` pricing precedent exists as the model for the window default;
  F106 is "narrowed, not retired" in exactly the story's terms, with the F064 descendant sweep
  carrying the second-reverify residual.
- **Substrate suites green on the working tree:** fanout-primitive + read-box-file 42/42,
  approval-gate 151/151 — the two suites the Infra Prerequisites table gates on.

---

## Verdict

**NOT CONVERGED.** Confidence: **HIGH** — every finding is traced to source, the primary-lens
enumeration is exhaustive over `reverify()`'s return/throw surface and the union's arm set, and
both substrate suites are green.

The story's verification culture is excellent — nearly every symbol, code, constant, docblock
quote and cross-story seam claim survives contact with the source, and the AC5 pre-flight and
null-arm mapping are reachability-correct. What blocks is one structural defect in exactly the
place this wave's lens was aimed: the `ChainOutcome` union, the story's central new contract,
has no arm for the three typed terminal outcomes its own ACs mandate (and its one unclaimed arm,
`unsettled`, has no producer), plus an unassigned exit for `vetoed` and an `approval-failed`
payload the shipped flattening cannot supply without an unstated log-capture. All three are
one-sentence spec amendments.

## Summary counts

| Severity | C1 citation rot | C2 semantic | C3 structural | C4 marginal wording | Total |
|---|---|---|---|---|---|
| BLOCKER | 0 | 0 | 1 | 0 | **1** |
| HIGH | 0 | 0 | 0 | 0 | **0** |
| MEDIUM | 0 | 1 | 1 | 0 | **2** |
| LOW | 0 | 1 | 1 | 3 | **5** |
| **Total** | **0** | **2** | **3** | **3** | **8** |
